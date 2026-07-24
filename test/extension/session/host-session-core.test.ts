// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  createDrainingDispatcher,
  createHostSessionCore,
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

const core = createHostSessionCore(ctx, { validateForWrite: fakeValidate });
const base = (over: Partial<HostSessionState> = {}): HostSessionState => ({
  context: ctx,
  lastAppliedDocVersion: 1,
  pendingApplyBaseVersion: null,
  disposed: false,
  rejection: { kind: "none" },
  nextRejectionId: 1,
  pendingEdit: null,
  inFlightContent: null,
  ...over,
});
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
    outcome: { kind: "ok", documentVersion: 2 },
    canWrite: true,
    currentContent: "cur",
    ...over,
  }) as const;

describe("host-session-core: ready/seed", () => {
  it("ready (no lock, no rejection) → postDocument(v1), rejection none", () => {
    const r = core.transition(base(), { type: "ready", documentVersion: 1 });
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 1 }]);
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
      { type: "postRejectedDraft", content: "draftBAD", error: unsafe, docVersion: 1, id: 5 },
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
      { type: "postDocument", docVersion: 1 },
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
      { type: "postRejectedDraft", content: "draftBAD", error: unsafe, docVersion: 1, id: 5 },
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
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 1 }]);
    expect(r.state.rejection).toEqual({ kind: "none" });
  });
  it("stale → postDocument, clears pending rejection", () => {
    const r = core.transition(
      pendingBase({ lastAppliedDocVersion: 2 }),
      edit({ baseDocVersion: 1, documentVersion: 2 })
    );
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
    expect(r.state.rejection).toEqual({ kind: "none" });
  });
  it("no-op (content === currentContent) → postDocument, clears pending rejection", () => {
    const r = core.transition(pendingBase(), edit({ content: "same", currentContent: "same" }));
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 1 }]);
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
    const r = core.transition(locked, settled({ outcome: { kind: "ok", documentVersion: 2 } }));
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    expect(r.state.lastAppliedDocVersion).toBe(2);
    expect(r.state.rejection).toEqual({ kind: "none" });
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
  });
  it("refused → release lock, postDocument + logWarn(heldBase) + showError(fsPath)", () => {
    const r = core.transition(locked, settled({ outcome: { kind: "refused" } }));
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    expect(r.effects[0]).toEqual({ type: "postDocument", docVersion: 1 });
    expect(r.effects[1]).toMatchObject({
      type: "logWarn",
      detail: { uri: ctx.uriString, baseDocVersion: 1 },
    });
    expect(r.effects[2]).toEqual({
      type: "showError",
      message: `Quoll could not save ${ctx.fsPath}. Reload the file or try again.`,
    });
  });
  it.each([
    "constructThrew",
    "applyThrew",
    "rejected",
  ] as const)("%s → release lock, postDocument + showError(message)", (kind) => {
    const r = core.transition(locked, settled({ outcome: { kind, message: "boom" } }));
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    expect(r.effects).toEqual([
      { type: "postDocument", docVersion: 1 },
      { type: "showError", message: "Failed to save: boom" },
    ]);
  });
  it("settle after dispose → no effects, state unchanged", () => {
    const disposed = base({ disposed: true, pendingApplyBaseVersion: null });
    const r = core.transition(disposed, settled({ outcome: { kind: "ok", documentVersion: 9 } }));
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(disposed);
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
      settled({ outcome: { kind: "ok", documentVersion: 2 }, currentContent: "edit1" })
    );
    expect(r.state.pendingEdit).toBeNull();
    expect(r.state.pendingApplyBaseVersion).toBe(2); // re-acquired (alive)
    expect(r.state.inFlightContent).toBe("edit1plus");
    expect(r.effects).toEqual([{ type: "applyEdit", content: "edit1plus", baseDocVersion: 2 }]);
  });

  it("EXTERNAL edit raced (currentContent !== inFlightContent) → NO drain, logWarn + repost authoritative Document (external wins)", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      settled({ outcome: { kind: "ok", documentVersion: 5 }, currentContent: "external-content" })
    );
    expect(r.state.pendingEdit).toBeNull();
    expect(r.state.pendingApplyBaseVersion).toBeNull();
    expect(r.effects).toEqual([
      {
        type: "logWarn",
        message:
          "[quoll] ok-but-mismatch on settle: external edit won the race, pending stash dropped",
        detail: { stashBase: 1, settledDocVersion: 5 },
      },
      { type: "postDocument", docVersion: 5 },
    ]);
  });

  it("non-ok outcome with a stash → NO drain, normal failure handling (stash dropped)", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      settled({ outcome: { kind: "refused" }, currentContent: "edit1" })
    );
    expect(r.state.pendingEdit).toBeNull();
    expect(r.effects[0]).toEqual({ type: "postDocument", docVersion: 1 });
    expect(r.effects.some((e) => e.type === "showError")).toBe(true);
    expect(r.effects.some((e) => e.type === "applyEdit")).toBe(false);
  });

  it("drain no-op (stash content === settled currentContent) → repost Document only", () => {
    const r = core.transition(
      lockedWithStash("same", "same"),
      settled({ outcome: { kind: "ok", documentVersion: 2 }, currentContent: "same" })
    );
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
  });

  it("drain parse-failed (ALIVE) → postRejectedDraft(draft, settled version) + showError, rejection pending", () => {
    const r = core.transition(
      lockedWithStash("edit1", "hasBAD"),
      settled({ outcome: { kind: "ok", documentVersion: 2 }, currentContent: "edit1" })
    );
    expect(r.state.rejection).toMatchObject({ kind: "pending", id: 1, content: "hasBAD" });
    // The draft is redelivered as a Document at the SETTLED version so the
    // webview's docVersion bookkeeping advances (I3: no silent version stall)
    // WITHOUT touching draft bytes — never a bare postEditRejected, never disk
    // bytes. Mirrors the shipped `ready`-arm redelivery precedent.
    expect(r.effects).toEqual([
      { type: "postRejectedDraft", content: "hasBAD", error: unsafe, docVersion: 2, id: 1 },
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
      settled({ outcome: { kind: "ok", documentVersion: 2 }, currentContent: "edit1" })
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
      settled({ outcome: { kind: "ok", documentVersion: 2 }, currentContent: "edit1" })
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
    expect(retry.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
  });

  it("drain readonly (canWrite=false) → repost Document only, no applyEdit", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus"),
      settled({
        outcome: { kind: "ok", documentVersion: 2 },
        canWrite: false,
        currentContent: "edit1",
      })
    );
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
  });

  it("POST-DISPOSE ok drain accept → applyEdit only, NO lock re-acquired, NO webview post", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({ outcome: { kind: "ok", documentVersion: 2 }, currentContent: "edit1" })
    );
    expect(r.state.pendingApplyBaseVersion).toBeNull(); // NOT re-acquired (Codex #5)
    expect(r.effects).toEqual([{ type: "applyEdit", content: "edit1plus", baseDocVersion: 2 }]);
  });

  it("POST-DISPOSE drain parse-failed → showError only (postEditRejected suppressed)", () => {
    const r = core.transition(
      lockedWithStash("edit1", "hasBAD", { disposed: true }),
      settled({ outcome: { kind: "ok", documentVersion: 2 }, currentContent: "edit1" })
    );
    expect(r.effects).toHaveLength(1);
    expect(r.effects[0]).toMatchObject({ type: "showError" });
  });

  it("POST-DISPOSE non-ok WITH a stash → showError only (failed save still surfaced), NO webview post", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({ outcome: { kind: "rejected", message: "boom" }, currentContent: "edit1" })
    );
    expect(r.effects).toEqual([{ type: "showError", message: "Failed to save: boom" }]);
  });

  it("POST-DISPOSE ok but external-mismatch WITH a stash → logWarn only, no toast (external won, webview-bound effects suppressed)", () => {
    const r = core.transition(
      lockedWithStash("edit1", "edit1plus", { disposed: true }),
      settled({ outcome: { kind: "ok", documentVersion: 2 }, currentContent: "external" })
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

  it("POST-DISPOSE settle with NO stash → strict no-op, state unchanged", () => {
    const disposed = base({ disposed: true });
    const r = core.transition(disposed, settled({ outcome: { kind: "ok", documentVersion: 9 } }));
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(disposed);
  });

  it("POST-DISPOSE FAILED settle with NO stash → showError only (drain's own applyEdit failure is not silent)", () => {
    const disposed = base({ disposed: true });
    const r = core.transition(
      disposed,
      settled({ outcome: { kind: "rejected", message: "boom" } })
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
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 1 }]);
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
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 7 }]);
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
    ).toEqual([{ type: "postDocument", docVersion: 1 }]);
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
      settled({ outcome: { kind: "ok", documentVersion: 2 } })
    );
    expect(batches[0]).toEqual([{ type: "applyEdit", content: "good", baseDocVersion: 1 }]);
    expect(batches[1]).toEqual([{ type: "postDocument", docVersion: 2 }]);
    expect(state.pendingApplyBaseVersion).toBeNull();
    expect(state.lastAppliedDocVersion).toBe(2);
  });

  it("accept → documentChanged WHILE locked → settled(ok): the in-flight documentChanged defers its post, so EXACTLY ONE Document is posted at the post-apply version (Codex N1 fix)", () => {
    const { batches, state } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      { type: "documentChanged", documentVersion: 2 }, // fires before the Promise settles, lock still held
      settled({ outcome: { kind: "ok", documentVersion: 2 } })
    );
    expect(batches[0]).toEqual([{ type: "applyEdit", content: "good", baseDocVersion: 1 }]);
    expect(batches[1]).toEqual([]); // <-- deferred: NO post while the lock is held
    expect(batches[2]).toEqual([{ type: "postDocument", docVersion: 2 }]); // settlement posts once
    // The whole trace emits exactly ONE Document, at the post-apply version.
    const posts = batches.flat().filter((e) => e.type === "postDocument");
    expect(posts).toEqual([{ type: "postDocument", docVersion: 2 }]);
    expect(state.pendingApplyBaseVersion).toBeNull();
    expect(state.lastAppliedDocVersion).toBe(2);
  });

  it("accept → documentChanged WHILE locked → settled(refused): the non-ok arm reseeds at the DEFERRED version (pins that the deferred documentChanged advanced lastAppliedDocVersion — Codex N1 fix)", () => {
    const { batches, state } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      { type: "documentChanged", documentVersion: 2 }, // fires before the Promise settles, lock still held
      settled({ outcome: { kind: "refused" } })
    );
    expect(batches[1]).toEqual([]); // deferred: NO post while the lock is held
    // The refused arm reseeds from released.lastAppliedDocVersion — which MUST be
    // the version the deferred documentChanged recorded (2), not the pre-apply 1.
    // A regression that drops the version update in the deferred path reddens here.
    expect(batches[2][0]).toEqual({ type: "postDocument", docVersion: 2 });
    expect(state.pendingApplyBaseVersion).toBeNull();
    expect(state.lastAppliedDocVersion).toBe(2);
  });

  it("accept → ready WHILE locked → settled(ok): the in-flight ready is dropped (echo-loop guard)", () => {
    const { batches } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      { type: "ready", documentVersion: 1 },
      settled({ outcome: { kind: "ok", documentVersion: 2 } })
    );
    expect(batches[1].map((e) => e.type)).toEqual(["logWarn"]); // ready dropped while locked
    expect(batches[2]).toEqual([{ type: "postDocument", docVersion: 2 }]);
  });

  it("accept → settled(constructThrew): optimistic lock is acquired then released (equivalence pin — Codex N4)", () => {
    const { state, batches } = run(
      base({ lastAppliedDocVersion: 1 }),
      edit({ content: "good", currentContent: "cur", baseDocVersion: 1, documentVersion: 1 }),
      settled({ outcome: { kind: "constructThrew", message: "lineAt blew up" } })
    );
    expect(batches[0]).toEqual([{ type: "applyEdit", content: "good", baseDocVersion: 1 }]);
    expect(batches[1]).toEqual([
      { type: "postDocument", docVersion: 1 },
      { type: "showError", message: "Failed to save: lineAt blew up" },
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
      settled({ outcome: { kind: "ok", documentVersion: 2 } })
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
});

describe("host-session-core: stale-version resync", () => {
  // Core lastApplied lags the live document (an external edit is still
  // coalescing in the documentChanged debounce). The posting arms must stamp
  // the LIVE version so the posted Document's version matches its live bytes —
  // otherwise the webview's next keystroke (based on the just-posted version)
  // is judged stale against the live version and reseeded away.
  it("ready resyncs to live documentVersion and posts it", () => {
    const r = core.transition(base({ lastAppliedDocVersion: 1 }), {
      type: "ready",
      documentVersion: 2,
    });
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
    expect(r.state.lastAppliedDocVersion).toBe(2);
  });
  it("seed resyncs to live documentVersion and posts it", () => {
    const r = core.transition(base({ lastAppliedDocVersion: 1 }), {
      type: "seed",
      documentVersion: 2,
    });
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
    expect(r.state.lastAppliedDocVersion).toBe(2);
  });
  it("viewStateVisible resyncs to live documentVersion and posts it", () => {
    const r = core.transition(base({ lastAppliedDocVersion: 1 }), {
      type: "viewStateVisible",
      documentVersion: 2,
    });
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
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
    expect(r.effects).toEqual([{ type: "postDocument", docVersion: 2 }]);
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
