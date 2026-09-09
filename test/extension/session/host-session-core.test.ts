// @vitest-environment node
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createDrainingDispatcher,
  createHostSessionCore,
  type HostSessionEffect,
  type HostSessionEvent,
  type HostSessionState,
  isWriteLockHeld,
} from "../../../src/extension/session/host-session-core.js";
import type { MarkdownError } from "../../../src/markdown/errors.js";
import type { ValidateForWriteResult } from "../../../src/markdown/validate-for-write.js";

const ctx = { uriString: "file:///x.md", fsPath: "/x.md" };
const unsafe: MarkdownError = {
  code: "unsafe_url",
  message: "URL is not in the allowlist: javascript:alert(1)",
};

// Fake validator: content containing "BAD" fails; everything else is ok.
const fakeValidate = (c: string): ValidateForWriteResult =>
  c.includes("BAD") ? { ok: false, error: unsafe } : { ok: true };

// Fixed generation nonce for the reducer under test — injected so every
// Document effect carries a deterministic identity (real minting is a
// counter-salted timestamp). `base()` seeds it directly into state.
const GEN = 777;
const core = createHostSessionCore(ctx, {
  validateForWrite: fakeValidate,
  mintEpochGeneration: () => GEN,
});
const base = (over: Partial<HostSessionState> = {}): HostSessionState => ({
  context: ctx,
  lastAppliedDocVersion: 1,
  pendingApplyBaseVersion: null,
  disposed: false,
  rejection: { kind: "none" },
  nextRejectionId: 1,
  pendingEdit: null,
  inFlightContent: null,
  externalEpoch: 0,
  epochGeneration: GEN,
  ...over,
});
// Expected postDocument effect carrying the S3a identity pair. `externalEpoch`
// defaults to 0 (no foreign advance); pass 1 for the foreign-advance arms.
const pDoc = (docVersion: number, externalEpoch = 0) =>
  ({ type: "postDocument", docVersion, externalEpoch, epochGeneration: GEN }) as const;
const edit = (over: Partial<Extract<HostSessionEvent, { type: "edit" }>> = {}) =>
  ({
    type: "edit",
    baseDocVersion: 1,
    content: "next",
    documentVersion: 1,
    canWrite: true,
    currentContent: "cur",
    ...over,
  }) as const;
const settled = (over: Partial<Extract<HostSessionEvent, { type: "applyEditSettled" }>> = {}) =>
  ({
    type: "applyEditSettled",
    outcome: { kind: "ok" },
    settledVersion: 2,
    canWrite: true,
    currentContent: "cur",
    // Canonical pre-apply snapshot (non-ok epoch baseline). Defaults equal to
    // currentContent so a non-ok settlement reads as "no foreign bytes" unless a
    // test overrides it. NOTE: the executor passes the REAL canonical snapshot on
    // every RESOLVED settlement, ok and non-ok alike; the inert "" placeholder
    // exists ONLY on the pipeline-REJECTION arm, whose currentContent is null.
    preApplyContent: "cur",
    ...over,
  }) as const;

// The ack Document, located by TYPE rather than by index. Tests that assert the
// reseed's STAMPED IDENTITY (version + epoch pair) care about the effect, not
// its position — the non-ok ordering is a separate contract, named by
// `expectToastBeforeReseed`.
const reseedIn = (effects: readonly HostSessionEffect[]) =>
  effects.find((e) => e.type === "postDocument");

// The non-ok settlement ORDER contract, asserted by INTENT rather than by the
// literal array shape: a failed save emits its `showError` BEFORE the ack
// `postDocument`. The reseed is the effect most likely to unwind the executor's
// effect loop — in production `buildSeedDocument` bottoms out in the same
// canonical-read seam whose throw produces a `rejected` outcome — so a toast
// ordered after it would be lost exactly when the user most needs it. Pinning
// the relative index alongside the literal arrays makes a reorder fail with the
// reason named instead of as an opaque array diff.
// ⚠️ CALL THIS BEFORE the whole-array/positional assertions at each site. Those
// assertions also encode the order, so vitest aborts the test on their diff
// first and this helper never runs — leaving exactly the opaque failure it
// exists to replace.
const expectToastBeforeReseed = (effects: readonly HostSessionEffect[]): void => {
  const toast = effects.findIndex((e) => e.type === "showError");
  const reseed = effects.findIndex((e) => e.type === "postDocument");
  expect(toast).toBeGreaterThanOrEqual(0);
  expect(reseed).toBeGreaterThanOrEqual(0);
  expect(toast).toBeLessThan(reseed);
};

describe("host-session-core: ready/seed", () => {
  it("ready (no lock, no rejection) → postDocument(v1), rejection none", () => {
    const r = core.transition(base(), { type: "ready", documentVersion: 1 });
    expect(r.effects).toEqual([pDoc(1)]);
    expect(r.state.rejection).toEqual({ kind: "none" });
  });
  it("ready while lock held → logWarn, no postDocument", () => {
    const r = core.transition(base({ pendingApplyBaseVersion: 1 }), {
      type: "ready",
      documentVersion: 1,
    });
    expect(r.effects.map((e) => e.type)).toEqual(["logWarn"]);
  });
  it("ready while rejection pending → postRejectedDraft(draft,v1), re-stamps a fresh delivery id (Codex N6)", () => {
    const s = base({
      rejection: { kind: "pending", id: 1, content: "draftBAD", error: unsafe },
      nextRejectionId: 5,
    });
    const r = core.transition(s, { type: "ready", documentVersion: 1 });
    // The effect carries the freshly re-stamped delivery id (5) so the executor
    // delivers the replay banner failure-aware (sendEditRejected(error, id))
    // rather than via a bare post — a failed replay then recovers (Codex N6).
    expect(r.effects).toEqual([
      {
        type: "postRejectedDraft",
        content: "draftBAD",
        error: unsafe,
        docVersion: 1,
        externalEpoch: 0,
        epochGeneration: GEN,
        id: 5,
      },
    ]);
    // The replay re-delivers A's banner and re-stamps its delivery id (5) so a
    // stale pre-replay delivery-failure can no longer re-clear A (Codex N6).
    expect(r.state.rejection).toEqual({
      kind: "pending",
      id: 5,
      content: "draftBAD",
      error: unsafe,
    });
    expect(r.state.nextRejectionId).toBe(6);
  });
  it("seed behaves identically to ready (no lock) → postDocument", () => {
    expect(core.transition(base(), { type: "seed", documentVersion: 1 }).effects).toEqual([
      pDoc(1),
    ]);
  });
  it("seed while rejection pending → postRejectedDraft(draft,v1), re-stamps a fresh delivery id (Codex N6)", () => {
    // `seed` shares the `ready` arm (the eager-seed handshake replays a pending
    // rejection the same way a webview reconnect does). Pin the N6 re-stamp on
    // the `seed` path explicitly so a future divergence — `seed` getting its own
    // branch that forgets the re-stamp / the `id` on the effect — reddens here
    // rather than silently regressing the failure-aware replay recovery.
    const s = base({
      rejection: { kind: "pending", id: 1, content: "draftBAD", error: unsafe },
      nextRejectionId: 5,
    });
    const r = core.transition(s, { type: "seed", documentVersion: 1 });
    expect(r.effects).toEqual([
      {
        type: "postRejectedDraft",
        content: "draftBAD",
        error: unsafe,
        docVersion: 1,
        externalEpoch: 0,
        epochGeneration: GEN,
        id: 5,
      },
    ]);
    expect(r.state.rejection).toEqual({
      kind: "pending",
      id: 5,
      content: "draftBAD",
      error: unsafe,
    });
    expect(r.state.nextRejectionId).toBe(6);
  });
});

describe("host-session-core: edit", () => {
  it("resyncs lastAppliedDocVersion from documentVersion", () => {
    const r = core.transition(
      base({ lastAppliedDocVersion: 1 }),
      edit({ documentVersion: 5, baseDocVersion: 5 })
    );
    expect(r.state.lastAppliedDocVersion).toBe(5);
  });
  it("lock held → STASH latest edit + logWarn (still resyncs version)", () => {
    const r = core.transition(
      base({ pendingApplyBaseVersion: 9 }),
      edit({ documentVersion: 3, content: "typed-while-locked", baseDocVersion: 3 })
    );
    expect(r.state.lastAppliedDocVersion).toBe(3);
    expect(r.state.pendingEdit).toEqual({ content: "typed-while-locked", baseDocVersion: 3 });
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0]).toMatchObject({ type: "logWarn" });
  });
  // Pins the lazy-snapshot optimisation: while the lock is held the stash arm
  // reads content/baseDocVersion only — NEVER currentContent — so the executor
  // may pass "" instead of canonicalising the whole doc (QuollEditorPanel edit
  // dispatch). A regression that starts reading currentContent in this arm
  // reddens here. Same stash + same effects with "" as with real content.
  it("lock held → stash ignores currentContent (lazy '' snapshot is safe)", () => {
    const empty = core.transition(
      base({ pendingApplyBaseVersion: 9 }),
      edit({
        documentVersion: 3,
        content: "typed-while-locked",
        baseDocVersion: 3,
        currentContent: "",
      })
    );
    const full = core.transition(
      base({ pendingApplyBaseVersion: 9 }),
      edit({
        documentVersion: 3,
        content: "typed-while-locked",
        baseDocVersion: 3,
        currentContent: "the whole canonical document text",
      })
    );
    expect(empty.state).toEqual(full.state);
    expect(empty.effects).toEqual(full.effects);
  });
  // The readonly/stale/no-op arms also clear a pending rejection (rejection: NONE)
  // — start each from a pending-rejection state so the clear is pinned non-vacuously
  // (a regression dropping the clear reddens state.rejection, not just effects).
  const pendingBase = (over: Partial<HostSessionState> = {}): HostSessionState =>
    base({ rejection: { kind: "pending", id: 1, content: "d", error: unsafe }, ...over });
  it("readonly → postDocument, clears pending rejection", () => {
    const r = core.transition(pendingBase(), edit({ canWrite: false }));
    expect(r.effects).toEqual([pDoc(1)]);
    expect(r.state.rejection).toEqual({ kind: "none" });
  });
  it("stale → postDocument, clears pending rejection", () => {
    const r = core.transition(
      pendingBase({ lastAppliedDocVersion: 2 }),
      edit({ baseDocVersion: 1, documentVersion: 2 })
    );
    expect(r.effects).toEqual([pDoc(2)]);
    expect(r.state.rejection).toEqual({ kind: "none" });
  });
  it("no-op (content === currentContent) → postDocument, clears pending rejection", () => {
    const r = core.transition(pendingBase(), edit({ content: "same", currentContent: "same" }));
    expect(r.effects).toEqual([pDoc(1)]);
    expect(r.state.rejection).toEqual({ kind: "none" });
  });
  it("parse-failed → rejection pending (id 1) + postEditRejected(id 1) + showError, nextRejectionId advances", () => {
    const r = core.transition(base(), edit({ content: "hasBAD", currentContent: "cur" }));
    expect(r.state.rejection).toEqual({ kind: "pending", id: 1, content: "hasBAD", error: unsafe });
    expect(r.state.nextRejectionId).toBe(2);
    expect(r.effects).toEqual([
      { type: "postEditRejected", error: unsafe, id: 1 },
      { type: "showError", message: `Cannot save: ${unsafe.message}` },
    ]);
  });
  it("accept → acquires lock + sets inFlightContent + applyEdit effect, clears pending rejection", () => {
    const s = base({ rejection: { kind: "pending", id: 1, content: "d", error: unsafe } });
    const r = core.transition(s, edit({ content: "good", currentContent: "cur" }));
    expect(r.state.pendingApplyBaseVersion).toBe(1);
    expect(r.state.inFlightContent).toBe("good");
    // The accepted edit supersedes the rejected draft — the rejection must not
    // survive into the lock (a delayed delivery-failure matching it would post
    // a Document mid-lock; the delivery-failure arm has no lock deferral).
    expect(r.state.rejection).toEqual({ kind: "none" });
    expect(r.effects).toEqual([{ type: "applyEdit", content: "good", baseDocVersion: 1 }]);
  });
});

describe("host-session-core: applyEditSettled", () => {
  const locked = base({
    pendingApplyBaseVersion: 1,
    lastAppliedDocVersion: 1,
    rejection: { kind: "pending", id: 1, content: "d", error: unsafe },
  });
  it("ok → release lock, advance version, clear rejection, postDocument(newV)", () => {
    const r = core.transition(locked, settled({ settledVersion: 2 }));
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    expect(r.state.lastAppliedDocVersion).toBe(2);
    expect(r.state.rejection).toEqual({ kind: "none" });
    expect(r.effects).toEqual([pDoc(2)]);
  });
  it("refused → release lock, logWarn(heldBase) + showError(fsPath) + postDocument", () => {
    const r = core.transition(locked, settled({ outcome: { kind: "refused" }, settledVersion: 1 }));
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    expectToastBeforeReseed(r.effects);
    expect(r.effects[0]).toMatchObject({
      type: "logWarn",
      detail: { uri: ctx.uriString, baseDocVersion: 1 },
    });
    expect(r.effects[1]).toEqual({
      type: "showError",
      message: `Quoll could not save ${ctx.fsPath}. Reload the file or try again.`,
    });
    expect(r.effects[2]).toEqual(pDoc(1));
  });
  it.each([
    "constructThrew",
    "applyThrew",
    "rejected",
  ] as const)("%s → release lock, showError(message) + postDocument", (kind) => {
    const r = core.transition(
      locked,
      settled({ outcome: { kind, message: "boom" }, settledVersion: 1 })
    );
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    expectToastBeforeReseed(r.effects);
    expect(r.effects).toEqual([{ type: "showError", message: "Failed to save: boom" }, pDoc(1)]);
  });
  it("settle after dispose → no effects, state unchanged", () => {
    const disposed = base({ disposed: true, pendingApplyBaseVersion: null });
    const r = core.transition(disposed, settled({ settledVersion: 9 }));
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(disposed);
  });

  // The settle-time verification reads are individually guarded in
  // `execute-write.ts`, so an UNOBSERVED snapshot arrives here as `null` rather
  // than as a pipeline rejection. Each of the three decisions that used to derive
  // its safety from an observed snapshot must now answer for `null`, and each
  // answers CONSERVATIVELY.
  it("an ok settlement with an UNKNOWN version leaves lastAppliedDocVersion alone (never rewinds, never fabricates)", () => {
    // NO documentChanged is injected here on purpose: the production resync that
    // usually raises the version is another module's incidental behaviour, so the
    // reducer must be correct without it. What it must NOT do is move the version
    // on an unobserved read. (The settlement advance is now `Math.max`-clamped —
    // the hoisted `advanced` const applies for EVERY outcome kind, no longer an
    // ok-only verbatim exemption from `resyncLiveVersion`'s clamp — so a fabricated
    // LOW sentinel could not rewind it either way; `null` is used instead of any
    // sentinel because a fabricated HIGH value would wrongly read as an observed
    // advance and license the ack gate.)
    const r = core.transition(locked, settled({ settledVersion: null, currentContent: null }));
    expect(r.state.lastAppliedDocVersion).toBe(1); // unchanged — not rewound, not invented
    expect(r.state.externalEpoch).toBe(locked.externalEpoch); // unobserved is NOT foreign
    expect(isWriteLockHeld(r.state)).toBe(false); // the lock is still released
  });

  it("an UNOBSERVED settlement with a write IN FLIGHT still does not bump the epoch", () => {
    // The distinguishing arrangement: `inFlightContent` is set, so the ok-branch
    // foreign-bytes compare is live and only the `observed !== null` guard keeps
    // it from firing. Treating a missing snapshot as foreign is the REJECTED
    // variant — it bumps the epoch and edit-sync drops the webview's replay
    // buffer. The no-op short-circuit lands here too: it reaches an unverified
    // `ok` WITHOUT submitting an apply, so the version legitimately does not move
    // and there is no evidence of anything foreign.
    const inFlight = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "edit1",
    });
    const r = core.transition(inFlight, settled({ settledVersion: null, currentContent: null }));
    expect(r.state.externalEpoch).toBe(inFlight.externalEpoch);
    expect(r.state.lastAppliedDocVersion).toBe(1);
  });

  it("a DIVERGED settlement with an unobserved version bumps the epoch but does not move the version", () => {
    // The remaining nullable combination: `readVersion` threw while the CONTENT
    // read worked, so the divergence verdict is real evidence (epoch++) while the
    // version is simply unknown (no advance).
    const r = core.transition(
      locked,
      settled({
        settledVersion: null,
        currentContent: "other",
        divergedAfterApply: true,
      })
    );
    expect(r.state.externalEpoch).toBe(locked.externalEpoch + 1);
    expect(r.state.lastAppliedDocVersion).toBe(locked.lastAppliedDocVersion);
  });
});

describe("host-session-core: applyEditSettled drain", () => {
  // Locked with edit #1 (inFlightContent) in flight + a stashed edit #2.
  const lockedWithStash = (inFlight: string, stash: string, over: Partial<HostSessionState> = {}) =>
    base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: inFlight,
      pendingEdit: { content: stash, baseDocVersion: 1 },
      ...over,
    });

  it("ALIVE ok, currentContent === inFlightContent → drain accept: applyEdit(stash) re-based, NO ack Document", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      settled({ settledVersion: 2, currentContent: "edit1" })
    );
    expect(r.state.pendingEdit).toBeNull();
    expect(r.state.pendingApplyBaseVersion).toBe(2); // re-acquired (alive)
    expect(r.state.inFlightContent).toBe("edit1plus");
    expect(r.effects).toEqual([{ type: "applyEdit", content: "edit1plus", baseDocVersion: 2 }]);
  });

  it("ALIVE ok, currentContent matches inFlightContent ONLY by EOL (CRLF-canonical vs LF-raw) → drain accept, NOT an external-won drop", () => {
    // The settled canonical content is document.eol (CRLF) while the webview's
    // inFlightContent is raw LF bytes — the webview's OWN acked lineage on a
    // CRLF-eol single-line doc, NOT an external edit. A raw byte compare would
    // misread this as "external won the apply→settle race" and DROP the stash
    // (data loss). The drain must proceed, mirroring the epoch-verdict EOL fix
    // (contentMatches). Reproduces the pre-fix skew: red without contentMatches.
    const r = core.transition(
      lockedWithStash("a\nb", "a\nb-plus"),
      settled({ settledVersion: 2, currentContent: "a\r\nb" })
    );
    expect(r.state.pendingEdit).toBeNull();
    expect(r.state.pendingApplyBaseVersion).toBe(2); // re-acquired (alive) = drained
    expect(r.state.inFlightContent).toBe("a\nb-plus");
    expect(r.effects).toEqual([{ type: "applyEdit", content: "a\nb-plus", baseDocVersion: 2 }]);
  });

  it("EXTERNAL edit raced (currentContent !== inFlightContent) → NO drain, logWarn + repost authoritative Document (external wins)", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      settled({ settledVersion: 5, currentContent: "external-content" })
    );
    expect(r.state.pendingEdit).toBeNull();
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    // ok-but-mismatch: external bytes won the apply→settle race, so the epoch
    // ADVANCES (site 2) — the settlement Document carries externalEpoch 1.
    expect(r.effects).toEqual([
      {
        type: "logWarn",
        message:
          "[quoll] ok-but-mismatch on settle: external edit won the race, pending stash dropped",
        detail: { stashBase: 1, settledDocVersion: 5 },
      },
      pDoc(5, 1),
    ]);
  });

  it("an UNOBSERVED settlement does not drain a waiting stash, and says so", () => {
    // The drain's safety condition is an OBSERVED equality — "the settled document
    // IS edit #1's exact result" — which is what keeps an external edit that won
    // the apply→settle race from being clobbered by the stash. Without the
    // observation that condition cannot be established, so the stash is dropped.
    // The version is deliberately OBSERVED here (`documentVersion: 2`) so this
    // isolates the CONTENT being unobserved.
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      settled({ settledVersion: 2, currentContent: null })
    );
    expect(r.state.pendingEdit).toBeNull(); // released
    expect(r.effects.some((e) => e.type === "applyEdit")).toBe(false); // but NOT written
    expect(r.effects.some((e) => e.type === "showError")).toBe(false); // not a failure
    // ...and not silent: post-dispose the stash is the keystroke's only carrier.
    expect(r.effects).toContainEqual({
      type: "logWarn",
      message:
        "[quoll] unverified settle: pending stash dropped because the settled document could not be read",
      detail: { stashBase: 1, settledDocVersion: 2 },
    });
    // An unobserved snapshot is NOT a mismatch — claiming "external edit won the
    // race" without having read the document would be a fabricated diagnosis.
    expect(
      r.effects.some((e) => e.type === "logWarn" && e.message.includes("ok-but-mismatch"))
    ).toBe(false);
  });

  it("non-ok outcome with a stash → NO drain, normal failure handling (stash dropped)", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      // Clean failure: the doc is still at the pre-apply snapshot (currentContent
      // === preApplyContent), so NO foreign bytes intervened → epoch unchanged
      // (0). The retry buffer must stay replayable.
      settled({
        outcome: { kind: "refused" },
        settledVersion: 1,
        currentContent: "edit1",
        preApplyContent: "edit1",
      })
    );
    expect(r.state.pendingEdit).toBeNull();
    expect(reseedIn(r.effects)).toEqual(pDoc(1));
    expect(r.effects.some((e) => e.type === "showError")).toBe(true);
    expect(r.effects.some((e) => e.type === "applyEdit")).toBe(false);
  });

  it("drain no-op (stash content === settled currentContent) → repost Document only", () => {
    const r = core.transition(
      lockedWithStash("same", "same"),
      settled({ settledVersion: 2, currentContent: "same" })
    );
    expect(r.effects).toEqual([pDoc(2)]);
  });

  it("drain parse-failed (ALIVE) → postRejectedDraft(draft, settled version) + showError, rejection pending", () => {
    const r = core.transition(
      lockedWithStash("edit1", "hasBAD"),
      settled({ settledVersion: 2, currentContent: "edit1" })
    );
    expect(r.state.rejection).toMatchObject({ kind: "pending", id: 1, content: "hasBAD" });
    // The draft is redelivered as a Document at the SETTLED version so the
    // webview's docVersion bookkeeping advances (so the next retry lands on a
    // live base instead of stale-rejecting) WITHOUT touching draft bytes —
    // never a bare postEditRejected, never disk bytes. Mirrors the shipped
    // `ready`-arm redelivery precedent.
    expect(r.effects).toEqual([
      {
        type: "postRejectedDraft",
        content: "hasBAD",
        error: unsafe,
        docVersion: 2,
        externalEpoch: 0,
        epochGeneration: GEN,
        id: 1,
      },
      { type: "showError", message: `Cannot save: ${unsafe.message}` },
    ]);
  });

  it("drain parse-failed (ALIVE) round-trip: the redelivered draft version un-stales the next retry", () => {
    // The bug (finding #2): the drain-over apply already advanced the reducer's
    // lastAppliedDocVersion, but the OLD arm posted no Document, so the webview
    // stayed on the pre-A version and its next retry arrived at a stale base →
    // stale verdict → authoritative reseed WIPED the draft. With the draft
    // redelivered at the settled version, the webview retries at the settled
    // base and is NOT stale-rejected.
    const drained = core.transition(
      lockedWithStash("edit1", "hasBAD"),
      settled({ settledVersion: 2, currentContent: "edit1" })
    );
    const draftDoc = drained.effects.find((e) => e.type === "postRejectedDraft");
    expect(draftDoc).toBeDefined();
    const retryBase = (draftDoc as { docVersion: number }).docVersion;
    // The webview retries at the version it just learned from the draft
    // Document (retryBase). `documentVersion` is pinned to the independently
    // known live version (2, same as the settled outcome above) rather than
    // reusing `retryBase` — decideEdit's staleness check compares
    // `baseDocVersion` against `documentVersion` (see host-session-core.ts's
    // edit-arm resync), so if the two args were both `retryBase` the check
    // would trivially pass regardless of what postRejectedDraft actually
    // carried. Pinning `documentVersion` independently means this only
    // passes if `retryBase` genuinely equals the live version.
    const retry = core.transition(
      drained.state,
      edit({ baseDocVersion: retryBase, documentVersion: 2, content: "fixed" })
    );
    // Not stale (no reseed): the fix is accepted and written.
    expect(retry.effects.some((e) => e.type === "postDocument")).toBe(false);
    expect(retry.effects).toContainEqual({
      type: "applyEdit",
      content: "fixed",
      baseDocVersion: retryBase,
    });
  });

  it("drain parse-failed (ALIVE) round-trip NEGATIVE: a retry still on the PRE-drain version IS stale-rejected (reproduces finding #2 without the fix)", () => {
    const drained = core.transition(
      lockedWithStash("edit1", "hasBAD"),
      settled({ settledVersion: 2, currentContent: "edit1" })
    );
    // Simulate the OLD (pre-fix) webview: it never learned the settled
    // version, so it retries with the stale pre-drain base (1) while the
    // live host document version is genuinely 2.
    const retry = core.transition(
      drained.state,
      edit({ baseDocVersion: 1, documentVersion: 2, content: "fixed" })
    );
    // Stale → authoritative reseed, NOT an applyEdit — the draft is wiped by
    // the reseed's Document (built from live document text, not the rejected
    // "fixed" content). This is exactly what the postRejectedDraft fix prevents
    // by advancing the webview to the settled version.
    expect(retry.effects).toEqual([pDoc(2)]);
  });

  it("drain readonly (canWrite=false) → repost Document only, no applyEdit", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      settled({
        settledVersion: 2,
        canWrite: false,
        currentContent: "edit1",
      })
    );
    expect(r.effects).toEqual([pDoc(2)]);
  });

  it("POST-DISPOSE ok drain accept → applyEdit only, NO lock re-acquired, NO webview post", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({ settledVersion: 2, currentContent: "edit1" })
    );
    expect(r.state.pendingApplyBaseVersion).toBeNull(); // NOT re-acquired (Codex #5)
    expect(r.effects).toEqual([{ type: "applyEdit", content: "edit1plus", baseDocVersion: 2 }]);
  });

  it("POST-DISPOSE drain parse-failed → showError only (postEditRejected suppressed)", () => {
    const r = core.transition(
      lockedWithStash("edit1", "hasBAD", { disposed: true }),
      settled({ settledVersion: 2, currentContent: "edit1" })
    );
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0]).toMatchObject({ type: "showError" });
  });

  it("POST-DISPOSE non-ok WITH a stash → showError only (failed save still surfaced), NO webview post", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({
        outcome: { kind: "rejected", message: "boom" },
        settledVersion: 1,
        currentContent: "edit1",
      })
    );
    expect(r.effects).toEqual([{ type: "showError", message: "Failed to save: boom" }]);
  });

  it("POST-DISPOSE ok but external-mismatch WITH a stash → logWarn only, no toast (external won, webview-bound effects suppressed)", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({ settledVersion: 2, currentContent: "external" })
    );
    expect(r.effects).toEqual([
      {
        type: "logWarn",
        message:
          "[quoll] ok-but-mismatch on settle: external edit won the race, pending stash dropped",
        detail: { stashBase: 1, settledDocVersion: 2 },
      },
    ]);
  });

  it("POST-DISPOSE UNOBSERVED settle WITH a stash → showError: the dropped edit is not silent", () => {
    // REGRESSION PIN. Before the settle-time reads were guarded, this exact
    // physical event (the settle-time canonical read threw) rejected the pipeline
    // and settled `rejected`, so its "Failed to save" toast reached the user
    // through the dispose filter. Guarding the reads makes the settlement `ok`,
    // whose baseEffects carry no toast at all — so without a toast of its own
    // this branch drops the stashed edit with nothing but a `logWarn`, and
    // post-dispose there is no webview replay buffer left to carry it.
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({ settledVersion: 2, currentContent: null })
    );
    const toasts = r.effects.filter((e) => e.type === "showError");
    expect(toasts).toHaveLength(1);
    // The wording must not re-introduce the false alarm that guarding the reads
    // removed: the write pipeline COMPLETED, only its verification is missing.
    // (Not "the apply landed" — the no-op short-circuit reaches this same family
    // without submitting an edit; see execute-write.ts's ⚠️ note at `settle`.)
    expect(toasts[0]).toMatchObject({ message: expect.stringContaining("could not verify") });
    expect(toasts[0]).toMatchObject({ message: expect.not.stringContaining("Failed to save") });
    // ...and it is IN ADDITION to the triage log, not instead of it.
    expect(
      r.effects.some((e) => e.type === "logWarn" && e.message.includes("unverified settle"))
    ).toBe(true);
  });

  it("ALIVE UNOBSERVED settle WITH a stash → NO toast (the webview replay buffer still carries it)", () => {
    // The other half of the same gate. Alive, the settlement deliberately does not
    // invalidate the webview's single-flight replay buffer, so the edit is
    // re-posted after the ack and a toast would be a false alarm. Dropping the
    // `state.disposed` gate above turns this red.
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      settled({ settledVersion: 2, currentContent: null })
    );
    expect(r.effects.some((e) => e.type === "showError")).toBe(false);
    expect(
      r.effects.some((e) => e.type === "logWarn" && e.message.includes("unverified settle"))
    ).toBe(true);
  });

  it("POST-DISPOSE ok-but-MISMATCH settle WITH a stash → still NO toast (external won is a resolution, not a loss)", () => {
    // Non-vacuity for the new toast's CONDITION, not just its presence: the
    // neighbouring post-dispose drop arm must stay silent. Widening the gate to
    // "any post-dispose stash drop" turns this red.
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({ settledVersion: 2, currentContent: "external" })
    );
    expect(r.effects.some((e) => e.type === "showError")).toBe(false);
  });

  it("POST-DISPOSE REJECTED settle (unobserved) WITH a stash → the 'Failed to save' toast ONLY, never both", () => {
    // Non-vacuity for the `kind === "ok"` conjunct of `unobservedStashDrop`.
    // This is the executor's rejection-arm settlement shape verbatim: a pipeline
    // rejection dispatches `kind: "rejected"` together with `currentContent: null`,
    // so EVERY other conjunct of the unverified-drop predicate holds and only the
    // ok-gate keeps the "saved but could not verify" toast off it. Two toasts here
    // would contradict each other about one event: the save FAILED, so there is no
    // save left to describe as unverified.
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({
        outcome: { kind: "rejected", message: "boom" },
        settledVersion: 1,
        currentContent: null,
      })
    );
    const toasts = r.effects.filter((e) => e.type === "showError");
    expect(toasts).toEqual([{ type: "showError", message: "Failed to save: boom" }]);
  });

  it("POST-DISPOSE settle with NO stash → strict no-op, state unchanged", () => {
    const disposed = base({ disposed: true });
    const r = core.transition(disposed, settled({ settledVersion: 9 }));
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(disposed);
  });

  it("POST-DISPOSE FAILED settle with NO stash → showError only (drain's own applyEdit failure is not silent)", () => {
    const disposed = base({ disposed: true });
    const r = core.transition(
      disposed,
      settled({ outcome: { kind: "rejected", message: "boom" }, settledVersion: 1 })
    );
    expect(r.effects).toEqual([{ type: "showError", message: "Failed to save: boom" }]);
    expect(r.state).toEqual(disposed);
  });
});

describe("host-session-core: misc transitions", () => {
  it("editRejectedDeliveryFailed (matching id) → clear rejection + postDocument", () => {
    const s = base({ rejection: { kind: "pending", id: 1, content: "d", error: unsafe } });
    const r = core.transition(s, { type: "editRejectedDeliveryFailed", id: 1, documentVersion: 1 });
    expect(r.state.rejection).toEqual({ kind: "none" });
    expect(r.effects).toEqual([pDoc(1)]);
  });
  it("editRejectedDeliveryFailed (stale id ≠ pending id) → no-op (Codex N2)", () => {
    const s = base({ rejection: { kind: "pending", id: 2, content: "d", error: unsafe } });
    const r = core.transition(s, { type: "editRejectedDeliveryFailed", id: 1, documentVersion: 1 });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });
  it("editRejectedDeliveryFailed while rejection none → no-op (Codex N2)", () => {
    const s = base({ rejection: { kind: "none" } });
    const r = core.transition(s, { type: "editRejectedDeliveryFailed", id: 1, documentVersion: 1 });
    expect(r.state).toEqual(s);
    expect(r.effects).toEqual([]);
  });
  it("documentChanged (no lock) → update version, clear rejection, postDocument(newV)", () => {
    const s = base({ rejection: { kind: "pending", id: 1, content: "d", error: unsafe } });
    const r = core.transition(s, { type: "documentChanged", documentVersion: 7 });
    expect(r.state.lastAppliedDocVersion).toBe(7);
    expect(r.state.rejection).toEqual({ kind: "none" });
    // Lock-free version advance from a foreign external edit → epoch++ (site 1).
    expect(r.effects).toEqual([pDoc(7, 1)]);
  });
  // Start from a pending rejection so the locked-arm's rejection clear is pinned
  // non-vacuously (parity with the no-lock variant above): a regression that
  // stops clearing the rejection during the lock reddens state.rejection, not
  // just effects.
  it("documentChanged while lock held → records version, clears rejection, NO post (deferred to settlement — Codex N1)", () => {
    const r = core.transition(
      base({
        pendingApplyBaseVersion: 1,
        lastAppliedDocVersion: 1,
        rejection: { kind: "pending", id: 1, content: "d", error: unsafe },
      }),
      { type: "documentChanged", documentVersion: 2 }
    );
    expect(r.effects).toEqual([]);
    expect(r.state.lastAppliedDocVersion).toBe(2);
    expect(r.state.pendingApplyBaseVersion).toBe(1);
    expect(r.state.rejection).toEqual({ kind: "none" });
  });
  // A dirty-state-only change event (save/autosave) fires with an UNCHANGED
  // version and empty contentChanges. The autosave-after-rejection sequence:
  // edit E1 applies (doc dirty) → edit E2 gets parse-failed → edit-rejected
  // (webview keeps typed bytes) → autosave fires. Re-posting the same-version
  // Document would clear the reject banner in the webview and destroy the
  // rejected draft, breaking the "preserves the user's typed bytes" invariant.
  // A version-identical event must no-op: rejection preserved, no post.
  it("documentChanged same version (autosave after rejection) → no-op, preserves pending rejection, NO post", () => {
    const rejection = { kind: "pending", id: 1, content: "hasBAD", error: unsafe } as const;
    const s = base({ lastAppliedDocVersion: 5, rejection });
    const r = core.transition(s, { type: "documentChanged", documentVersion: 5 });
    expect(r.state).toEqual(s);
    expect(r.state.rejection).toEqual(rejection);
    expect(r.effects).toEqual([]);
  });
  it("themeChanged → postTheme (carries the themeKind through, incl. HC)", () => {
    expect(core.transition(base(), { type: "themeChanged", themeKind: "dark" }).effects).toEqual([
      { type: "postTheme", themeKind: "dark" },
    ]);
    expect(core.transition(base(), { type: "themeChanged", themeKind: "hc-dark" }).effects).toEqual(
      [{ type: "postTheme", themeKind: "hc-dark" }]
    );
  });
  it("viewStateVisible while lock held → no effect", () => {
    expect(
      core.transition(base({ pendingApplyBaseVersion: 1 }), {
        type: "viewStateVisible",
        documentVersion: 1,
      }).effects
    ).toEqual([]);
  });
  it("viewStateVisible while rejection pending → logWarn only", () => {
    const s = base({ rejection: { kind: "pending", id: 1, content: "d", error: unsafe } });
    expect(
      core
        .transition(s, { type: "viewStateVisible", documentVersion: 1 })
        .effects.map((e) => e.type)
    ).toEqual(["logWarn"]);
  });
  it("viewStateVisible normal → postDocument", () => {
    expect(
      core.transition(base(), { type: "viewStateVisible", documentVersion: 1 }).effects
    ).toEqual([pDoc(1)]);
  });
  it("openExternal → openExternal effect", () => {
    expect(
      core.transition(base(), { type: "openExternal", href: "https://e.com" }).effects
    ).toEqual([{ type: "openExternal", href: "https://e.com" }]);
  });
  it("disposed → disposed flag + lock cleared", () => {
    const r = core.transition(base({ pendingApplyBaseVersion: 1 }), { type: "disposed" });
    expect(r.state.disposed).toBe(true);
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    expect(r.effects).toEqual([]);
  });
  it("any event after disposed (except disposed) → no effects", () => {
    expect(
      core.transition(base({ disposed: true }), { type: "themeChanged", themeKind: "dark" }).effects
    ).toEqual([]);
  });
});

// Trace tests — the reducer's payoff: pin whole protocol sequences cheaply
// (Codex N6). `run(initial, ...events)` folds the sequence and returns every
// batch of effects so the ordering invariants are asserted, not just single arms.
describe("host-session-core: traces", () => {
  const run = (initial: HostSessionState, ...events: HostSessionEvent[]) => {
    let state = initial;
    const batches: ReturnType<typeof core.transition>["effects"][] = [];
    for (const ev of events) {
      const r = core.transition(state, ev);
      state = r.state;
      batches.push(r.effects);
    }
    return { state, batches };
  };

  it("accept → settled(ok): lock acquired then released, two postDocuments at the new version", () => {
    const { state, batches } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      // Clean settlement: the settled doc IS the applied bytes ("good"), so the
      // epoch does NOT advance (site 2 baseline = inFlightContent).
      settled({ settledVersion: 2, currentContent: "good" })
    );
    expect(batches[0]).toEqual([{ type: "applyEdit", content: "good", baseDocVersion: 1 }]);
    expect(batches[1]).toEqual([pDoc(2)]);
    expect(state.pendingApplyBaseVersion).toBeNull();
    expect(state.lastAppliedDocVersion).toBe(2);
  });

  it("accept → documentChanged WHILE locked → settled(ok): the in-flight documentChanged defers its post, so EXACTLY ONE Document is posted at the post-apply version (Codex N1 fix)", () => {
    const { batches, state } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      { type: "documentChanged", documentVersion: 2 }, // fires before the Promise settles, lock still held
      // The deferred documentChanged is the in-flight apply's OWN echo (lock
      // held → no epoch bump), and the settled doc IS the applied bytes → clean,
      // epoch 0.
      settled({ settledVersion: 2, currentContent: "good" })
    );
    expect(batches[0]).toEqual([{ type: "applyEdit", content: "good", baseDocVersion: 1 }]);
    expect(batches[1]).toEqual([]); // <-- deferred: NO post while the lock is held
    expect(batches[2]).toEqual([pDoc(2)]); // settlement posts once
    // The whole trace emits exactly ONE Document, at the post-apply version.
    const posts = batches.flat().filter((e) => e.type === "postDocument");
    expect(posts).toEqual([pDoc(2)]);
    expect(state.pendingApplyBaseVersion).toBeNull();
    expect(state.lastAppliedDocVersion).toBe(2);
  });

  it("accept → documentChanged WHILE locked → settled(refused): the non-ok arm reseeds at the DEFERRED version (pins that the deferred documentChanged advanced lastAppliedDocVersion — Codex N1 fix)", () => {
    const { batches, state } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      { type: "documentChanged", documentVersion: 2 }, // fires before the Promise settles, lock still held
      settled({ outcome: { kind: "refused" }, settledVersion: 1 })
    );
    expect(batches[1]).toEqual([]); // deferred: NO post while the lock is held
    // The refused arm reseeds from released.lastAppliedDocVersion — which MUST be
    // the version the deferred documentChanged recorded (2), not the pre-apply 1.
    // A regression that drops the version update in the deferred path reddens here.
    expect(reseedIn(batches[2])).toEqual(pDoc(2));
    expect(state.pendingApplyBaseVersion).toBeNull();
    expect(state.lastAppliedDocVersion).toBe(2);
  });

  it("accept → ready WHILE locked → settled(ok): the in-flight ready is dropped (echo-loop guard)", () => {
    const { batches } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      { type: "ready", documentVersion: 1 },
      settled({ settledVersion: 2, currentContent: "good" })
    );
    expect(batches[1].map((e) => e.type)).toEqual(["logWarn"]); // ready dropped while locked
    expect(batches[2]).toEqual([pDoc(2)]);
  });

  it("accept → settled(constructThrew): optimistic lock is acquired then released (equivalence pin — Codex N4)", () => {
    const { state, batches } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      settled({ outcome: { kind: "constructThrew", message: "lineAt blew up" }, settledVersion: 1 })
    );
    expect(batches[0]).toEqual([{ type: "applyEdit", content: "good", baseDocVersion: 1 }]);
    expectToastBeforeReseed(batches[1]);
    expect(batches[1]).toEqual([
      { type: "showError", message: "Failed to save: lineAt blew up" },
      pDoc(1),
    ]);
    expect(state.pendingApplyBaseVersion).toBeNull();
  });

  it("rejection A → external resync → rejection B → A's late delivery-failure: B SURVIVES (Codex N2/R1 — operation identity)", () => {
    // The real N2 race (per the N2 Done-when): an external documentChanged
    // resync lands between rejection A and rejection B, so the webview's
    // single-flight tracker does NOT coalesce them. A's delivery-failure
    // arrives LATE, after B is pending. With per-rejection operation
    // identity, the stale failure (issued for A) must be IGNORED — it may
    // only clear the rejection it was issued for, never the newer B.
    let s = base({ lastAppliedDocVersion: 1 });
    // (1) Edit A fails to parse → rejection A pending, postEditRejected(A).
    s = core.transition(
      s,
      edit({ content: "firstBAD", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 })
    ).state;
    const idA = (s.rejection as { id: number }).id;
    // (2) External resync (onDidChangeTextDocument) clears A's rejection.
    s = core.transition(s, { type: "documentChanged", documentVersion: 2 }).state;
    expect(s.rejection).toEqual({ kind: "none" });
    // (3) Edit B fails to parse → rejection B pending (a DISTINCT id).
    s = core.transition(
      s,
      edit({ content: "secondBAD", currentContent: "cur", baseDocVersion: 2, documentVersion: 2 })
    ).state;
    expect(s.rejection).toMatchObject({ kind: "pending", content: "secondBAD" });
    // (4) A's late delivery-failure carries A's id → ignored; B survives.
    const r = core.transition(s, {
      type: "editRejectedDeliveryFailed",
      id: idA,
      documentVersion: 2,
    });
    expect(r.state.rejection).toMatchObject({ kind: "pending", content: "secondBAD" });
    expect(r.effects).toEqual([]);
  });

  it("rejection A → valid edit acquires the write lock (A's banner superseded) → A's late delivery-failure lands MID-LOCK: NO Document post while the lock is held", () => {
    // The delivery-failure arm has no lock deferral (unlike documentChanged /
    // viewStateVisible), so the lock-held invariant must hold structurally:
    // a rejection may never still be pending once the accept arm takes the
    // lock. If it survived the accept, a delayed delivery-failure would match
    // and post a pre-apply-version Document mid-lock — an unsolicited reseed
    // that clears the webview's editInFlight and can transiently wipe the
    // accepted edit's content.
    let s = base({ lastAppliedDocVersion: 1 });
    // (1) Edit E1 fails to parse → rejection A pending, postEditRejected(A)
    //     delivery in flight (its failure has not landed yet).
    s = core.transition(
      s,
      edit({ content: "firstBAD", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 })
    ).state;
    const idA = (s.rejection as { id: number }).id;
    // (2) The webview posts a valid edit E2 superseding the rejected draft →
    //     the accept arm acquires the write lock. E2 supersedes A's banner,
    //     so the rejection must clear here (every other inbound-edit arm and
    //     every settlement path already clears it).
    s = core.transition(
      s,
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 })
    ).state;
    expect(s.pendingApplyBaseVersion).toBe(1);
    // (3) A's delayed delivery-failure lands while the lock is held → it must
    //     NOT emit a Document (nor any other effect) mid-lock.
    const r = core.transition(s, {
      type: "editRejectedDeliveryFailed",
      id: idA,
      documentVersion: 1,
    });
    expect(r.effects).toEqual([]);
    expect(r.state.pendingApplyBaseVersion).toBe(1);
  });

  it("rejection A → A's delivery-failure issued (attempt 1 in-flight) → ready replay re-delivers A → attempt-1's failure lands: A's replayed banner SURVIVES (Codex N6 — per-delivery identity)", () => {
    // N6: after a `ready` replay re-delivers rejection A (a fresh, successful
    // re-delivery via postRejectedDraft), a DELAYED delivery-failure for A's
    // PRE-replay attempt must not clear A. The replay re-stamps A's delivery
    // id, so attempt-1's failure (carrying the pre-replay id) no longer matches
    // → no-op. Without the re-stamp the replayed A reuses A's identity and the
    // stale failure wipes the banner the replay just restored.
    let s = base({ lastAppliedDocVersion: 1 });
    // (1) Edit A fails to parse → rejection A pending, postEditRejected(A) in flight.
    s = core.transition(
      s,
      edit({ content: "firstBAD", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 })
    ).state;
    const attempt1Id = (s.rejection as { id: number }).id;
    // (2) `ready` replay re-delivers A → re-stamps a fresh delivery id. The
    // effect carries that fresh id (attempt1Id + 1) so the executor delivers
    // the replay banner failure-aware via sendEditRejected(error, id).
    const replay = core.transition(s, { type: "ready", documentVersion: 1 });
    s = replay.state;
    expect(replay.effects).toEqual([
      {
        type: "postRejectedDraft",
        content: "firstBAD",
        error: unsafe,
        docVersion: 1,
        externalEpoch: 0,
        epochGeneration: GEN,
        id: attempt1Id + 1,
      },
    ]);
    expect((s.rejection as { id: number }).id).not.toBe(attempt1Id);
    // (3) attempt-1's delayed delivery-failure lands → ignored; A survives.
    const r = core.transition(s, {
      type: "editRejectedDeliveryFailed",
      id: attempt1Id,
      documentVersion: 1,
    });
    expect(r.state.rejection).toMatchObject({ kind: "pending", content: "firstBAD" });
    expect(r.effects).toEqual([]);
  });

  it("disposed → late settled: settlement is a no-op", () => {
    const { batches, state } = run(
      base({ pendingApplyBaseVersion: 1, lastAppliedDocVersion: 1 }),
      { type: "disposed" },
      settled({ settledVersion: 2 })
    );
    expect(batches[0]).toEqual([]);
    expect(batches[1]).toEqual([]);
    expect(state.disposed).toBe(true);
  });
});

// The dispatch primitive itself (Codex R2): the production dispatcher IS
// createDrainingDispatcher, so a regression that drops the draining guard or
// re-introduces recursion reddens here rather than passing the reducer traces.
describe("createDrainingDispatcher", () => {
  it("drains a re-entrant dispatch FIFO, AFTER the current step completes (not recursively)", () => {
    const log: string[] = [];
    let dispatch!: (e: string) => void;
    dispatch = createDrainingDispatcher<string>((event) => {
      log.push(`enter:${event}`);
      if (event === "a") {
        dispatch("b"); // an "effect" re-dispatches mid-step
      }
      log.push(`exit:${event}`);
    });
    dispatch("a");
    // b runs ONLY after a's step fully completes. Recursive dispatch would give
    // ["enter:a","enter:b","exit:b","exit:a"]; the draining guard gives:
    expect(log).toEqual(["enter:a", "exit:a", "enter:b", "exit:b"]);
  });

  it("preserves FIFO order across multiple re-entrant dispatches", () => {
    const seen: string[] = [];
    let dispatch!: (e: string) => void;
    dispatch = createDrainingDispatcher<string>((event) => {
      seen.push(event);
      if (event === "root") {
        dispatch("x");
        dispatch("y");
      }
    });
    dispatch("root");
    expect(seen).toEqual(["root", "x", "y"]);
  });

  it("a fresh top-level dispatch after the queue drains starts a new drain", () => {
    const seen: string[] = [];
    const dispatch = createDrainingDispatcher<string>((event) => seen.push(event));
    dispatch("one");
    dispatch("two");
    expect(seen).toEqual(["one", "two"]);
  });

  // FAILURE POLICY on a throwing `step` (see the dispatcher's own comment). The
  // queue is drained to EMPTY before the error leaves the dispatcher, so an
  // event a doomed step already enqueued can never be replayed later against a
  // diverged state. Before this policy the drain abandoned the queue and `seen`
  // stopped at ["a"].
  it("drains the queue to empty when a step throws, then rethrows that error", () => {
    const seen: string[] = [];
    const boom = new Error("step threw");
    let dispatch!: (e: string) => void;
    dispatch = createDrainingDispatcher<string>((event) => {
      seen.push(event);
      if (event === "a") {
        dispatch("b"); // enqueued behind the active drain...
        throw boom; // ...and abandoned by the throw, before this policy
      }
    });
    let thrown: unknown = "NOTHING THROWN";
    try {
      dispatch("a");
    } catch (err) {
      thrown = err;
    }
    // Identity, not just shape: a single failure must reach the caller as the
    // very error the step threw, so existing handlers keep their triage payload.
    expect(thrown).toBe(boom);
    expect(seen).toEqual(["a", "b"]);
    // ...and NO residue survives into the next dispatch (the released `draining`
    // guard starts a fresh drain that sees only its own event).
    dispatch("c");
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("aggregates when more than one step throws in the same drain", () => {
    const first = new Error("first");
    const second = new Error("second");
    let dispatch!: (e: string) => void;
    dispatch = createDrainingDispatcher<string>((event) => {
      if (event === "a") {
        dispatch("b");
        throw first;
      }
      throw second;
    });
    let thrown: unknown = "NOTHING THROWN";
    try {
      dispatch("a");
    } catch (err) {
      thrown = err;
    }
    // Every failure survives: swallowing the later ones would hide a fault that
    // only the completed drain can produce.
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([first, second]);
  });

  // The rethrow counts ENTRIES, not truthiness, so a step that throws a falsy
  // value still reaches the caller as that value rather than as "no failure".
  it("rethrows a falsy thrown value instead of treating the drain as clean", () => {
    const dispatch = createDrainingDispatcher<string>(() => {
      // A non-Error throw is the ASSERTION here, not sloppiness: it is exactly
      // the value a truthiness-based rethrow would swallow.
      // biome-ignore lint/style/useThrowOnlyError: the non-Error throw is the fixture
      throw undefined;
    });
    let caught = false;
    let thrown: unknown = "NOTHING THROWN";
    try {
      dispatch("a");
    } catch (err) {
      caught = true;
      thrown = err;
    }
    expect(caught).toBe(true);
    expect(thrown).toBeUndefined();
  });

  it("throws nothing when every queued step succeeds", () => {
    const seen: string[] = [];
    let dispatch!: (e: string) => void;
    dispatch = createDrainingDispatcher<string>((event) => {
      seen.push(event);
      if (event === "a") {
        dispatch("b");
      }
    });
    expect(() => dispatch("a")).not.toThrow();
    expect(seen).toEqual(["a", "b"]);
  });
});

describe("host-session-core: stale-version resync", () => {
  // Core lastApplied lags the live document (an external edit is still
  // coalescing in the documentChanged debounce). The posting arms must stamp
  // the LIVE version so the posted Document's version matches its live bytes —
  // otherwise the webview's next keystroke (based on the just-posted version)
  // is judged stale against the live version and reseeded away.
  // Each resync here raises the version from a FOREIGN external edit (the
  // coalescing debounce), all lock-free → the epoch advances to 1 (site 1).
  it("ready resyncs to live documentVersion and posts it", () => {
    const r = core.transition(base({ lastAppliedDocVersion: 1 }), {
      type: "ready",
      documentVersion: 2,
    });
    expect(r.effects).toEqual([pDoc(2, 1)]);
    expect(r.state.lastAppliedDocVersion).toBe(2);
  });
  it("seed resyncs to live documentVersion and posts it", () => {
    const r = core.transition(base({ lastAppliedDocVersion: 1 }), {
      type: "seed",
      documentVersion: 2,
    });
    expect(r.effects).toEqual([pDoc(2, 1)]);
    expect(r.state.lastAppliedDocVersion).toBe(2);
  });
  it("viewStateVisible resyncs to live documentVersion and posts it", () => {
    const r = core.transition(base({ lastAppliedDocVersion: 1 }), {
      type: "viewStateVisible",
      documentVersion: 2,
    });
    expect(r.effects).toEqual([pDoc(2, 1)]);
    expect(r.state.lastAppliedDocVersion).toBe(2);
  });
  it("editRejectedDeliveryFailed (matching id) resyncs to live version and posts it", () => {
    const s = base({
      lastAppliedDocVersion: 1,
      rejection: { kind: "pending", id: 1, content: "d", error: unsafe },
    });
    const r = core.transition(s, {
      type: "editRejectedDeliveryFailed",
      id: 1,
      documentVersion: 2,
    });
    expect(r.effects).toEqual([pDoc(2, 1)]);
    expect(r.state.lastAppliedDocVersion).toBe(2);
    expect(r.state.rejection).toEqual({ kind: "none" });
  });
});

describe("isWriteLockHeld", () => {
  it("is false on the initial state (no apply in flight)", () => {
    const { initialState } = createHostSessionCore({ uriString: "u", fsPath: "/u" });
    expect(isWriteLockHeld(initialState(1))).toBe(false);
  });

  it("is true after an accepted edit acquires the lock", () => {
    const core = createHostSessionCore({ uriString: "u", fsPath: "/u" });
    const seeded = core.transition(core.initialState(1), {
      type: "seed",
      documentVersion: 1,
    }).state;
    const afterEdit = core.transition(seeded, {
      type: "edit",
      baseDocVersion: 1,
      content: "new content\n",
      documentVersion: 1,
      canWrite: true,
      currentContent: "old content\n",
    }).state;
    expect(isWriteLockHeld(afterEdit)).toBe(true);
  });
});

// --- S3a: externalEpoch / epochGeneration behaviour (reproduce-first) ---
describe("host-session-core: externalEpoch (S3a)", () => {
  it("edit arm: lock-free foreign coalescing advance → stale verdict posts a BUMPED epoch (finding #4 front door)", () => {
    // The killer case. An external edit N→N+1 landed in the debounce; the
    // webview's Edit at base N (=1) arrives with the live documentVersion
    // already at N+1 (=2). Lock-free ⇒ the resync-first step (resyncLiveVersion)
    // increments the epoch, and the `stale` verdict's authoritative Document
    // carries it — WITHOUT it the resync would swallow the advance and finding
    // #4 recurs (the later debounced documentChanged no-ops at the version check).
    const r = core.transition(
      base({ lastAppliedDocVersion: 1 }),
      edit({
        baseDocVersion: 1,
        documentVersion: 2,
        content: "webview-edit",
        currentContent: "external-bytes",
      })
    );
    expect(r.state.lastAppliedDocVersion).toBe(2);
    expect(r.state.externalEpoch).toBe(1);
    expect(r.effects).toEqual([pDoc(2, 1)]);
  });

  it("own-edit ok settlement with matching content → epoch UNCHANGED (the acked lineage is not foreign)", () => {
    const locked = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "applied",
    });
    const r = core.transition(locked, settled({ settledVersion: 2, currentContent: "applied" }));
    expect(r.state.externalEpoch).toBe(0);
    expect(r.effects).toEqual([pDoc(2)]);
  });

  it("ok settlement differing from inFlight ONLY by EOL → epoch UNCHANGED (CRLF-canonical vs LF-raw is NOT foreign)", () => {
    // The settled canonical content is document.eol (CRLF) while the webview's
    // inFlightContent is raw LF bytes — a plain newline-adding edit on a
    // CRLF-eol single-line doc. This is the webview's OWN acked lineage, NOT a
    // foreign edit; a byte compare would spuriously bump the epoch (and S3b
    // would then drop the replay buffer = data loss).
    const locked = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "a\nb",
    });
    const r = core.transition(locked, settled({ settledVersion: 2, currentContent: "a\r\nb" }));
    expect(r.state.externalEpoch).toBe(0);
    expect(r.effects).toEqual([pDoc(2)]);
  });

  it("non-ok settlement differing from the pre-apply snapshot ONLY by EOL → epoch UNCHANGED", () => {
    const locked = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "a\nb",
    });
    const r = core.transition(
      locked,
      settled({
        outcome: { kind: "refused" },
        settledVersion: 1,
        currentContent: "a\r\nb",
        preApplyContent: "a\nb",
      })
    );
    expect(r.state.externalEpoch).toBe(0);
    expect(reseedIn(r.effects)).toEqual(pDoc(1));
  });

  it("ok-but-mismatch settlement (external won under the lock) → epoch++", () => {
    const locked = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "target",
    });
    const r = core.transition(locked, settled({ settledVersion: 2, currentContent: "foreign" }));
    expect(r.state.externalEpoch).toBe(1);
    expect(r.effects).toEqual([pDoc(2, 1)]);
  });

  it("non-ok settlement with the doc STILL at the pre-apply snapshot → epoch UNCHANGED (failed-save retry stays replayable)", () => {
    const locked = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "target",
    });
    const r = core.transition(
      locked,
      settled({
        outcome: { kind: "refused" },
        settledVersion: 1,
        currentContent: "pre-apply",
        preApplyContent: "pre-apply",
      })
    );
    expect(r.state.externalEpoch).toBe(0);
    expect(reseedIn(r.effects)).toEqual(pDoc(1));
  });

  it("non-ok settlement with foreign bytes (doc diverged from the pre-apply snapshot) → epoch++", () => {
    const locked = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "target",
    });
    const r = core.transition(
      locked,
      settled({
        outcome: { kind: "refused" },
        settledVersion: 1,
        currentContent: "foreign-bytes",
        preApplyContent: "pre-apply",
      })
    );
    // A foreign edit raced the FAILED apply — comparing against inFlightContent
    // would have MISSED this (the apply never landed "target").
    expect(r.state.externalEpoch).toBe(1);
    expect(reseedIn(r.effects)).toEqual(pDoc(1, 1));
  });

  // --- S6: divergedAfterApply annotation (finding #7) ---
  it("divergedAfterApply settlement (apply ok, landed !== intended) → epoch++ + authoritative resync + a distinct diverged log + NO error toast", () => {
    const locked = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "target",
    });
    const r = core.transition(
      locked,
      settled({
        settledVersion: 2,
        currentContent: "misplaced-splice",
        divergedAfterApply: true,
      })
    );
    // Convergence shape (the existing ok-but-mismatch handling): epoch++ so the
    // reposted Document drops the webview's now-stale buffer, and the settled
    // Document carries the bumped epoch.
    expect(r.state.externalEpoch).toBe(1);
    expect(r.effects).toContainEqual(pDoc(2, 1));
    // A distinct diverged log fires for triage.
    expect(r.effects).toContainEqual(
      expect.objectContaining({
        type: "logWarn",
        message: expect.stringContaining("divergedAfterApply on settle"),
      })
    );
    // A deliberate conflict resolution is NOT a save failure — no error toast.
    expect(r.effects.some((e) => e.type === "showError")).toBe(false);
  });

  it("divergedAfterApply forces the epoch bump even if the byte compare were inconclusive (explicit flag drives convergence)", () => {
    // Drive convergence off the flag, not the currentContent-vs-inFlight compare:
    // even with currentContent byte-matching inFlight, the explicit annotation
    // must still increment (the executor is the authoritative divergence verdict).
    const locked = base({
      pendingApplyBaseVersion: 1,
      lastAppliedDocVersion: 1,
      inFlightContent: "target",
    });
    const r = core.transition(
      locked,
      settled({
        settledVersion: 2,
        currentContent: "target",
        divergedAfterApply: true,
      })
    );
    expect(r.state.externalEpoch).toBe(1);
  });

  it("resyncLiveVersion never rewinds: a LOWER documentChanged version leaves lastApplied + epoch untouched", () => {
    // A late/reordered event carrying a version below the current one must not
    // rewind lastAppliedDocVersion (max clamp) and must not increment the epoch
    // (no forward advance).
    const s = base({ lastAppliedDocVersion: 5, externalEpoch: 3 });
    const r = core.transition(s, { type: "documentChanged", documentVersion: 2 });
    expect(r.state.lastAppliedDocVersion).toBe(5);
    expect(r.state.externalEpoch).toBe(3);
  });

  it("epochGeneration is minted once and is stable across transitions", () => {
    const c = createHostSessionCore(ctx, {
      validateForWrite: fakeValidate,
      mintEpochGeneration: () => 42,
    });
    let st = c.initialState(1);
    expect(st.epochGeneration).toBe(42);
    expect(st.externalEpoch).toBe(0);
    // A foreign advance bumps the epoch but never the generation (identity).
    const after = c.transition(st, { type: "documentChanged", documentVersion: 2 });
    st = after.state;
    expect(st.epochGeneration).toBe(42);
    expect(st.externalEpoch).toBe(1);
    expect(after.effects).toEqual([
      { type: "postDocument", docVersion: 2, externalEpoch: 1, epochGeneration: 42 },
    ]);
  });

  // Structural backstop: the ONLY writes to `lastAppliedDocVersion` are the
  // single `resyncLiveVersion` helper, `initialState`, and the settlement
  // advance. The advance is now the hoisted `advanced` const applied via
  // `Math.max` to EVERY outcome kind (no longer an ok-only verbatim exemption).
  // A future hand-rolled arm that raises the version directly (bypassing the
  // helper, re-opening the epoch under-advance that reintroduces finding #4
  // silently) adds a new RHS token here and reddens. Comments are stripped
  // first so a rule-shaped literal in a doc-comment cannot vacuate the guard
  // (LEARNING: source-contract grep).
  it("INVARIANT: lastAppliedDocVersion is only written by resyncLiveVersion / initialState / settlement-advance", () => {
    const source = readFileSync(
      new URL("../../../src/extension/session/host-session-core.ts", import.meta.url),
      "utf8"
    );
    const codeOnly = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    const rhs = [...codeOnly.matchAll(/lastAppliedDocVersion:\s*([^,\n]+)/g)].map((m) =>
      // Strip trailing punctuation (`,` `;` `}` and whitespace) so `number;`
      // and the inline-ternary `event.outcome.documentVersion }` normalise to
      // their bare RHS token.
      m[1].trim().replace(/[;,}\s]+$/, "")
    );
    // Allowed RHS tokens:
    //  - `raised`     → resyncLiveVersion (the one helper)
    //  - `docVersion` → initialState seed
    //  - `advanced`   → the settlement advance, Math.max over event.settledVersion
    //                   for EVERY outcome kind (no longer an ok-only exemption)
    //  - `number`     → the readonly field type declaration
    //  - `resynced.lastAppliedDocVersion` / `settled.lastAppliedDocVersion`
    //                 → decideEdit ARGS (reads, not writes)
    const allowed = new Set([
      "raised",
      "docVersion",
      "advanced",
      "number",
      "resynced.lastAppliedDocVersion",
      "settled.lastAppliedDocVersion",
    ]);
    const disallowed = rhs.filter((token) => !allowed.has(token));
    expect(disallowed).toEqual([]);
  });
});

describe("host-session-core: settlement ack-label gate (ackLabelObserved)", () => {
  const locked = base({ pendingApplyBaseVersion: 1, inFlightContent: "edit1" });

  it("WITHHOLDS the ack when no source observed a post-apply version (ok, unobserved settle + no lock-held advance)", () => {
    const r = core.transition(locked, settled({ settledVersion: null, currentContent: null }));
    expect(r.effects.find((e) => e.type === "postDocument")).toBeUndefined();
    expect(r.effects.some((e) => e.type === "showResyncFailure")).toBe(true);
    expect(r.effects.some((e) => e.type === "logWarn")).toBe(true);
    // No fabricated advance, no spurious epoch bump.
    expect(r.state.lastAppliedDocVersion).toBe(1);
    expect(r.state.externalEpoch).toBe(0);
  });

  it("POSTS the ack when the version advanced under the lock (lock-held documentChanged was a real observation)", () => {
    // documentChanged during the lock raised lastApplied 1→2 (no epoch bump, lock-held branch).
    const s = base({
      pendingApplyBaseVersion: 1,
      inFlightContent: "edit1",
      lastAppliedDocVersion: 2,
    });
    const r = core.transition(s, settled({ settledVersion: null, currentContent: null }));
    expect(reseedIn(r.effects)).toEqual(pDoc(2));
    expect(r.effects.some((e) => e.type === "showResyncFailure")).toBe(false);
  });

  it("a lock-held raise licenses the ack even though the raise's PRODUCER is unattributable (accepted residual)", () => {
    // Same disjunct as the test above, but composed from the two events that
    // produce it instead of a hand-placed `lastAppliedDocVersion`, so the trace
    // is the real one: a `documentChanged` arrives while the lock is held and
    // raises the label, then the settlement observes nothing at all.
    // ⚠️ The reducer cannot tell WHO raised it. `resyncLiveVersion` takes no
    // producer (VS Code's change event carries none, and the lock-held wiring
    // snapshots only the version), so this same state is reached both by our own
    // apply's echo — the central, correct case the deferral contract depends on —
    // and by a FOREIGN edit landing while our echo never arrived, where the ack
    // then labels live bytes one version behind. Today we ack in BOTH: the states
    // are identical, so no predicate separates them, and withholding would kill
    // the deferral contract's only receiver. Accepted residual; the backstop is
    // the liveness TODO entry. Narrowing this disjunct turns this test red on
    // purpose — that is the conversation it exists to force.
    const raised = core.transition(locked, { type: "documentChanged", documentVersion: 2 });
    const r = core.transition(
      raised.state,
      settled({ settledVersion: null, currentContent: null })
    );
    expect(reseedIn(r.effects)).toEqual(pDoc(2));
    expect(r.effects.some((e) => e.type === "showResyncFailure")).toBe(false);
    expect(r.state.externalEpoch).toBe(0); // delta 1 === our own contribution
  });

  it("byte equality does NOT license the ack (undone foreign edit leaves identical bytes at a higher version)", () => {
    // Content observed and EQUAL to the in-flight bytes — still withheld without a version observation.
    const r = core.transition(locked, settled({ settledVersion: null, currentContent: "edit1" }));
    expect(r.effects.find((e) => e.type === "postDocument")).toBeUndefined();
    expect(r.effects.some((e) => e.type === "showResyncFailure")).toBe(true);
  });

  it("non-ok arms get the same gate: refused + unobserved version withholds the ack but KEEPS the failure toast", () => {
    const r = core.transition(
      locked,
      settled({ outcome: { kind: "refused" }, settledVersion: null, currentContent: null })
    );
    expect(r.effects.find((e) => e.type === "postDocument")).toBeUndefined();
    expect(r.effects.some((e) => e.type === "showError")).toBe(true);
    expect(r.effects.some((e) => e.type === "showResyncFailure")).toBe(true);
  });

  it("the no-op short-circuit's UNCHANGED observed version licenses the ack (delta 0 is not foreign)", () => {
    // settledVersion === heldBase: nothing was applied, the observation confirms the label.
    const r = core.transition(locked, settled({ settledVersion: 1, currentContent: null }));
    expect(reseedIn(r.effects)).toEqual(pDoc(1));
    expect(r.state.externalEpoch).toBe(0);
  });

  it("POST-DISPOSE the withhold pair is suppressed with the rest of the webview-bound effects", () => {
    // Disposed + no stash + unobserved version. The early return builds
    // `failureToasts(outcome, context)` directly and never reaches
    // `settlementEffects`, so neither the ack nor the withhold pair is
    // CONSTRUCTED here at all — there is no ack-label gate on this path to
    // observe. What this pins is that non-construction: `ok` leaves no effects
    // at all, `refused` leaves toasts and nothing else.
    const disposed = base({ disposed: true, pendingApplyBaseVersion: null });
    const ok = core.transition(disposed, settled({ settledVersion: null, currentContent: null }));
    expect(ok.effects).toEqual([]);
    const refused = core.transition(
      disposed,
      settled({ outcome: { kind: "refused" }, settledVersion: null, currentContent: null })
    );
    expect(refused.effects.every((e) => e.type === "showError")).toBe(true);
    expect(refused.effects.length).toBeGreaterThan(0);
  });

  it("editRejectedDeliveryFailed with an UNOBSERVED version clears the rejection but WITHHOLDS the recovery reseed", () => {
    // The recovery reseed pairs LIVE bytes with the version label, so an
    // unobserved version gets the same answer as the settlement ack gate.
    // (`unsafe` is the file's existing MarkdownError fixture, :18.)
    const s = base({
      rejection: { kind: "pending", id: 7, content: "draft", error: unsafe },
      nextRejectionId: 8,
    });
    const r = core.transition(s, {
      type: "editRejectedDeliveryFailed",
      id: 7,
      documentVersion: null,
    });
    expect(r.state.rejection).toEqual({ kind: "none" }); // no deadlock: pending is cleared
    expect(r.effects.find((e) => e.type === "postDocument")).toBeUndefined(); // no fabricated label
    expect(r.effects.some((e) => e.type === "showResyncFailure")).toBe(true);
    expect(r.state.lastAppliedDocVersion).toBe(1); // nothing observed, nothing advanced
  });

  it("editRejectedDeliveryFailed null-version STILL respects the id guard (stale failure is a no-op)", () => {
    const s = base({
      rejection: { kind: "pending", id: 9, content: "draft", error: unsafe },
      nextRejectionId: 10,
    });
    const r = core.transition(s, {
      type: "editRejectedDeliveryFailed",
      id: 7,
      documentVersion: null,
    });
    expect(r.state).toBe(s);
    expect(r.effects).toEqual([]);
  });

  it("after a null-version recovery the next OBSERVED event reseeds normally (convergence)", () => {
    // Two steps: the withheld recovery clears the rejection, so a later
    // lock-free documentChanged takes the normal resync path — observed label
    // + the foreign-advance epoch bump ride the reseed. (Codex r4 90.)
    const s = base({
      rejection: { kind: "pending", id: 7, content: "draft", error: unsafe },
      nextRejectionId: 8,
    });
    const withheld = core.transition(s, {
      type: "editRejectedDeliveryFailed",
      id: 7,
      documentVersion: null,
    });
    const r = core.transition(withheld.state, { type: "documentChanged", documentVersion: 2 });
    expect(reseedIn(r.effects)).toEqual(pDoc(2, 1));
  });
});

describe("host-session-core: unified settledVersion advance (every outcome, Math.max)", () => {
  const locked = base({ pendingApplyBaseVersion: 1, inFlightContent: "edit1" });

  it("a NON-OK settlement with an observed version advances via Math.max and acks at the observed label", () => {
    // refused + a foreign edit raced the failed apply: doc moved 1→2, content unobserved.
    const r = core.transition(
      locked,
      settled({ outcome: { kind: "refused" }, settledVersion: 2, currentContent: null })
    );
    expect(r.state.lastAppliedDocVersion).toBe(2);
    // delta 1 > heldBase + 0 → positive foreign evidence → epoch bump rides the ack.
    expect(r.state.externalEpoch).toBe(1);
    expect(reseedIn(r.effects)).toEqual(pDoc(2, 1));
  });

  it("Math.max never rewinds: an observed settledVersion LOWER than lastApplied leaves it untouched", () => {
    const s = base({
      pendingApplyBaseVersion: 2,
      inFlightContent: "edit1",
      lastAppliedDocVersion: 3,
    });
    const r = core.transition(s, settled({ settledVersion: 2, currentContent: null }));
    expect(r.state.lastAppliedDocVersion).toBe(3);
  });
});

describe("host-session-core: content-unobserved epoch verdict is positive version-delta evidence only", () => {
  const locked = base({ pendingApplyBaseVersion: 1, inFlightContent: "edit1" });

  it("ok + unobserved content: delta === own contribution (+1) is NOT foreign", () => {
    const r = core.transition(locked, settled({ settledVersion: 2, currentContent: null }));
    expect(r.state.externalEpoch).toBe(0);
    expect(reseedIn(r.effects)).toEqual(pDoc(2));
  });

  it("ok + unobserved content: delta BEYOND own contribution IS foreign (epoch++ rides the ack)", () => {
    const r = core.transition(locked, settled({ settledVersion: 3, currentContent: null }));
    expect(r.state.externalEpoch).toBe(1);
    expect(reseedIn(r.effects)).toEqual(pDoc(3, 1));
  });

  it("no advance at all stays NOT foreign (missing ⇒ foreign is the rejected variant)", () => {
    const r = core.transition(locked, settled({ settledVersion: null, currentContent: null }));
    expect(r.state.externalEpoch).toBe(0);
  });

  it("a label RAISED under the lock supplies the delta even when the settlement observed nothing", () => {
    // Composed from two events rather than hand-placed state, because the point
    // is WHERE the evidence comes from: the settlement itself observed neither
    // the version nor the content, and the only number the verdict can use is the
    // one a lock-held `documentChanged` wrote into `lastAppliedDocVersion`.
    // heldBase 1 → raised to 3 (delta 2) → beyond our own +1 → foreign.
    // A verdict that read `event.settledVersion` instead of the reducer's label
    // would score 0 here and leave the epoch at 0, while the sibling tests above
    // (which DO observe a version) stay green — this is the arm that catches it.
    const raised = core.transition(locked, { type: "documentChanged", documentVersion: 3 });
    expect(raised.effects).toEqual([]); // deferred: the lock is still held
    expect(raised.state.externalEpoch).toBe(0); // a lock-held advance never bumps
    const r = core.transition(
      raised.state,
      settled({ settledVersion: null, currentContent: null })
    );
    expect(r.state.lastAppliedDocVersion).toBe(3);
    expect(r.state.externalEpoch).toBe(1);
    expect(reseedIn(r.effects)).toEqual(pDoc(3, 1));
  });
});

describe("host-session-core: an unobserved ack label still DRAINS (bytes first)", () => {
  // `canDrain` gates on CONTENT evidence, never on the ack label: the drain is a
  // new WRITE, not an ack. One review cycle added an `ackLabelObserved` conjunct
  // and it was reverted — refusing the drain drops the keystroke, and the only
  // carrier left (the webview replay buffer) is destroyed by the ORDINARY
  // continuation, because the apply DID move the document and its later
  // `documentChanged` then reads as a lock-free forward advance ⇒ epoch++ ⇒
  // `edit-sync.ts`'s `recordedEpoch > buf.epoch` drop. Draining instead
  // self-heals: the `accept` arm re-acquires the lock, so that same echo lands
  // LOCK-HELD and bumps nothing.
  // What the drain accepts is the STALE RE-BASE residual — the re-acquired base
  // is a lower bound, so a later settlement that ALSO misses its content read can
  // score our own increment as foreign (one spurious bump, bytes already landed).
  // The tests below pin BOTH halves: the write happens, and the residual is
  // stated rather than asserted away.
  const lockedStash = (stash: string) =>
    base({
      pendingApplyBaseVersion: 1,
      inFlightContent: "edit1",
      pendingEdit: { content: stash, baseDocVersion: 1 },
    });
  const unobserved = settled({ settledVersion: null, currentContent: "edit1" });
  // The EXACT pair `withholdAckEffects` builds at an unobserved label, shared by
  // the two readonly/stale/no-op tests below so their exhaustive `toEqual`s
  // cannot drift apart. `lockedStash` fixes both numbers in the detail.
  const withheldAck = [
    {
      type: "logWarn",
      message: expect.stringContaining(
        "settlement ack withheld: no post-apply document version was observed"
      ),
      detail: { uri: ctx.uriString, heldBase: 1, lastAppliedDocVersion: 1 },
    },
    { type: "showResyncFailure" },
  ];

  it("an accept-shaped stash IS applied: the keystroke is written at the stale base", () => {
    const r = core.transition(lockedStash("edit1-more"), unobserved);
    // EXHAUSTIVE: the write, preceded by the drain's own record of the residual
    // it is accepting. The record is what lets a later spurious epoch bump be
    // attributed to the drain that caused it.
    expect(r.effects).toEqual([
      {
        type: "logWarn",
        message: expect.stringContaining("unlabelled drain"),
        detail: { uri: ctx.uriString, heldBase: 1, lastAppliedDocVersion: 1 },
      },
      { type: "applyEdit", content: "edit1-more", baseDocVersion: 1 },
    ]);
    // ARM-SPECIFIC clause: this is the `accept` verdict, so the bytes DID land —
    // pinned separately from the `parse-failed` arm's "no bytes land" wording,
    // and in the same shape that arm uses.
    expect(
      r.effects.find((e) => e.type === "logWarn" && e.message.includes("unlabelled drain"))
    ).toEqual(expect.objectContaining({ message: expect.stringContaining("The bytes land") }));
    expect(r.state.pendingEdit).toBeNull();
    // The lock IS re-acquired — this is what makes the label's catch-up
    // lock-HELD in the test below, and so what keeps the epoch still.
    expect(r.state.pendingApplyBaseVersion).toBe(1);
    expect(r.state.inFlightContent).toBe("edit1-more");
    expect(r.state.externalEpoch).toBe(0);
    // The reverted arm-4 token, kept NAMED rather than kept as a guard: with the
    // drain's own "unlabelled drain" record now in the array above, the
    // exhaustive `toEqual` is what would catch arm 4 coming back (a third
    // effect). This line survives so the two tokens cannot be confused — arm 4's
    // "unlabelled settle" reported a REFUSED drain's dropped keystroke, and with
    // the drain running there is no dropped keystroke to report.
    expect(
      r.effects.some((e) => e.type === "logWarn" && e.message.includes("unlabelled settle"))
    ).toBe(false);
  });

  it("ACCEPTED RESIDUAL: a second content-unobserved settlement scores our own increment as foreign — ONE bump, bytes already landed", () => {
    // The residual the describe header STATES, measured rather than asserted
    // away. It takes a SECOND independent read failure to reach: the drained
    // apply's own settlement must also miss its CONTENT read, so the epoch
    // verdict falls back to the version delta — which reads the re-acquired
    // base as EXACT while it is really a lower bound.
    const drained = core.transition(lockedStash("edit1-more"), unobserved);
    expect(drained.state.pendingApplyBaseVersion).toBe(1); // the stale lower bound
    const second = core.transition(
      drained.state,
      settled({ settledVersion: 3, currentContent: null })
    );
    expect(second.state.externalEpoch).toBe(1); // exactly ONE spurious bump
    expect(second.state.lastAppliedDocVersion).toBe(3);
    expect(second.state.pendingEdit).toBeNull(); // nothing further dropped
    expect(reseedIn(second.effects)).toEqual(pDoc(3, 1)); // the ack still goes out
  });

  it("the drain re-acquires the lock, so the label's catch-up is LOCK-HELD and spends no epoch", () => {
    // The validator's cycle-2 trace, pinned in the direction the adjudication
    // chose. Under the reverted gate this state had `pendingApplyBaseVersion:
    // null`, so this same `documentChanged` was a lock-FREE forward advance:
    // epoch 1, and `edit-sync.ts`'s `recordedEpoch > buf.epoch` drop check then
    // discards the replay buffer holding the keystroke the refusal had just
    // dropped. Re-adding the conjunct to `canDrain` turns this red.
    const r = core.transition(lockedStash("edit1-more"), unobserved);
    const after = core.transition(r.state, { type: "documentChanged", documentVersion: 2 });
    expect(after.effects).toEqual([]); // deferred: the lock is held
    expect(after.state.externalEpoch).toBe(0);
    expect(after.state.lastAppliedDocVersion).toBe(2);
  });

  it("the drained apply's own settlement catches the label up; the late echo is then a no-op", () => {
    // The other half of the convergence: the drain's applyEdit settles WITH an
    // observation, which advances the label to the live version and acks there.
    // The delayed `documentChanged` for that same edit is then version-identical
    // and no-ops, so the epoch is invariant across the whole catch-up — no
    // spurious bump anywhere on this path.
    const r = core.transition(lockedStash("edit1-more"), unobserved);
    // PREMISE, pinned so it cannot be vacated silently: step 2 is the DRAINED
    // apply's settlement. Without the drain the lock is free and `inFlightContent`
    // null, and everything below still passes while measuring a different event.
    expect(r.state.inFlightContent).toBe("edit1-more");
    const s2 = core.transition(
      r.state,
      settled({ settledVersion: 2, currentContent: "edit1-more" })
    );
    expect(reseedIn(s2.effects)).toEqual(pDoc(2));
    expect(s2.state.externalEpoch).toBe(0);
    const after = core.transition(s2.state, { type: "documentChanged", documentVersion: 2 });
    expect(after.effects).toEqual([]);
    expect(after.state.externalEpoch).toBe(0);
  });

  it("a parse-failing stash DOES reach decideEdit: the draft is redelivered at the STORED label", () => {
    // The ACCEPTED RESIDUAL, pinned LITERALLY rather than asserted away: with no
    // observation the draft Document carries `docVersion: 1` — the stored label,
    // which may be one edit behind the live document. Every LOCAL gate for this
    // was reviewed and rejected (a `ready` replay redelivers at the stored label
    // with no resync regardless); the durable fix is the liveness-backstop TODO
    // entry. If that entry lands, this expectation is what must change.
    const r = core.transition(lockedStash("hasBAD"), unobserved);
    expect(r.effects.find((e) => e.type === "postRejectedDraft")).toEqual({
      type: "postRejectedDraft",
      content: "hasBAD",
      error: unsafe,
      docVersion: 1,
      externalEpoch: 0,
      epochGeneration: GEN,
      id: 1,
    });
    expect(r.state.rejection).toEqual({ kind: "pending", id: 1, content: "hasBAD", error: unsafe });
    expect(r.state.nextRejectionId).toBe(2); // a delivery id WAS minted
    expect(r.effects.some((e) => e.type === "showError")).toBe(true);
    // The stale label the draft carries is exactly what the drain's record
    // names, so this arm carries it too — and its ARM-SPECIFIC clause says NO
    // bytes land, pinned separately from the `accept` arm's "The bytes land"
    // wording. One assertion covers both: a missing record fails the `toEqual`.
    expect(
      r.effects.find((e) => e.type === "logWarn" && e.message.includes("unlabelled drain"))
    ).toEqual(expect.objectContaining({ message: expect.stringContaining("no bytes land") }));
  });

  it("a no-op-shaped stash withholds the repost the drain arm makes (EXHAUSTIVE: no stray 'unlabelled drain' log)", () => {
    // The drain RUNS here and reaches the `no-op` verdict; what withholds the
    // repost is the ACK gate (`ackEffects`), not `canDrain`. This is the pin that
    // keeps that withhold branch from being deleted as unreachable. EXHAUSTIVE
    // now (not just a partial find/some pair): this readonly/stale/no-op arm
    // deliberately does NOT spread `staleReBaseWarn` (that residual is already
    // logged through `withholdAckEffects`, the `withheldAck` pair above) — a
    // `toEqual` is what would catch a future "for consistency" regression that
    // spreads it in anyway.
    const r = core.transition(lockedStash("edit1"), unobserved);
    expect(r.effects).toEqual(withheldAck);
  });

  it("a readonly-shaped stash withholds the repost the drain arm makes, at an UNOBSERVED label", () => {
    // The `readonly` sibling of the test above: `canWrite: false` also lands in
    // the readonly/stale/no-op arm, and the only existing `canWrite: false`
    // drain test uses an OBSERVED label (line ~572) — this is the missing
    // UNOBSERVED-label case named by the describe header.
    const r = core.transition(
      lockedStash("edit1-more-ro"),
      settled({ settledVersion: null, currentContent: "edit1", canWrite: false })
    );
    expect(r.effects).toEqual(withheldAck);
    // NEGATIVE: no "unlabelled drain" record leaks into this arm.
    expect(
      r.effects.some((e) => e.type === "logWarn" && e.message.includes("unlabelled drain"))
    ).toBe(false);
  });

  it("an OBSERVED label drains the same way — only the re-base is not stale", () => {
    const r = core.transition(
      lockedStash("edit1-more"),
      settled({ settledVersion: 2, currentContent: "edit1" })
    );
    // NEGATIVE pin, by exhaustive equality: no "unlabelled drain" record here.
    // There is no residual to report when the base rests on an observation, so
    // an unconditional record would cry wolf on the ordinary path.
    expect(r.effects).toEqual([{ type: "applyEdit", content: "edit1-more", baseDocVersion: 2 }]);
  });

  it("POST-DISPOSE drains the same way — there the stash is the keystroke's ONLY carrier", () => {
    // Same drain, different stakes: no webview means no replay buffer, so the
    // stash is the sole carrier. The `accept` arm deliberately does NOT re-acquire
    // the lock here (no more edits arrive), which is why no later settlement ever
    // reads this base.
    const s = base({
      disposed: true,
      pendingApplyBaseVersion: null, // the dispose transition already cleared it
      inFlightContent: "edit1",
      pendingEdit: { content: "edit1-more", baseDocVersion: 1 },
    });
    const r = core.transition(s, settled({ settledVersion: null, currentContent: "edit1" }));
    // NEGATIVE pin on the "unlabelled drain" record, by exhaustive equality: the
    // label is unobserved here too, but with no lock re-acquired neither
    // consequence that record names can occur (no later settlement reads this
    // base, and no draft goes out), so reporting one would be a false claim.
    expect(r.effects).toEqual([{ type: "applyEdit", content: "edit1-more", baseDocVersion: 1 }]);
    expect(r.state.pendingApplyBaseVersion).toBeNull(); // lock NOT re-acquired
  });
});
