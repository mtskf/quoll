// @vitest-environment node
//
// Regression pin for the stranded host write lock: `runApplyEdit` used to attach
// only an `onFulfilled` arm (`void executeDocumentWrite(…).then(ok)`), so a
// REJECTED write pipeline was left UNHANDLED by that `void` (`void` discards the
// promise reference; it does not catch). `applyEditSettled` is the
// only event that clears `pendingApplyBaseVersion` (dispose aside), so the lock
// stayed held for the rest of the session and every later edit was stashed
// behind a bare `console.warn` and never written — silent, toast-free data loss
// for that panel.
//
// The unit-level mapping (rejection → non-ok settlement, empty snapshots,
// guarded `canWrite`) is pinned in effect-executor.test.ts. THIS file wires the
// real reducer to the real executor so the assertion is the user-visible one:
// after a failed settlement the NEXT keystroke still reaches the document.

import { describe, expect, it } from "vitest";

import {
  createEffectExecutor,
  type EffectExecutor,
} from "../../../src/extension/session/effect-executor.js";
import {
  createDrainingDispatcher,
  createHostSessionCore,
  type HostSessionEvent,
  type HostSessionState,
  isWriteLockHeld,
} from "../../../src/extension/session/host-session-core.js";
import type { HostToWebview } from "../../../src/shared/protocol.js";

const ctx = { uriString: "file:///x.md", fsPath: "/x.md" };
const okValidate = () => ({ ok: true }) as const;

// Flush the executor's async settlement (executeDocumentWrite awaits the apply,
// then runApplyEdit's `.then` dispatches) — a handful of microtask turns.
const flushSettle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

// Reducer + executor wired exactly as the panel wires them, over a fake document
// whose settle-time canonical read can be armed to throw. `build` is the write
// ATTEMPT probe: it runs only once the reducer has ACCEPTED an edit and issued
// the `applyEdit` effect, so a stashed (lock-blocked) keystroke leaves no entry.
function harness() {
  const core = createHostSessionCore(ctx, { validateForWrite: okValidate });
  const doc = { version: 1, text: "" };
  const attempts: string[] = [];
  const errors: string[] = [];
  const seedBuilds: string[] = [];
  let failSettle = false;

  let live: HostSessionState = core.initialState(doc.version);
  const dispatchEvent = createDrainingDispatcher((event: HostSessionEvent) => {
    const r = core.transition(live, event);
    live = r.state;
    executor.runEffects(r.effects);
  });

  const executor: EffectExecutor = createEffectExecutor({
    isDisposed: () => false,
    getState: () => live,
    uriString: () => ctx.uriString,
    dispatch: dispatchEvent,
    send: async () => true,
    recordEvent: () => {},
    showError: (message) => errors.push(message),
    canWrite: () => true,
    // Gated on the SAME `failSettle` flag as `readCanonical` on purpose: in
    // production both bottom out in `canonicalDocumentText(document)` (the panel
    // wires `buildSeedDocument` → `canonicalDocumentText` and
    // `applyEditSeam.readCanonical` → the same function), so a seam that breaks
    // the settle-time read breaks the reseed too. A harness that reads a plain
    // `doc.text` here would decouple the two and hide the correlated failure:
    // `settlementEffects` emits the reseed BEFORE the toast, so a throwing
    // reseed takes the "Failed to save" notification down with it.
    buildSeedDocument: (docVersion, externalEpoch, epochGeneration) => {
      seedBuilds.push(`v${docVersion}`);
      if (failSettle) {
        throw new Error("boom-seed");
      }
      return {
        protocol: 1,
        type: "document",
        content: doc.text,
        docVersion,
        canWrite: true,
        themeKind: "light",
        externalEpoch,
        epochGeneration,
      } as HostToWebview;
    },
    buildRejectedDraft: (content, docVersion, externalEpoch, epochGeneration) =>
      ({
        protocol: 1,
        type: "document",
        content,
        docVersion,
        canWrite: true,
        themeKind: "light",
        externalEpoch,
        epochGeneration,
      }) as HostToWebview,
    buildTheme: (themeKind) => ({ protocol: 1, type: "theme", themeKind }) as HostToWebview,
    buildEditRejected: (error) => ({ protocol: 1, type: "edit-rejected", error }) as HostToWebview,
    applyEditSeam: {
      readText: () => doc.text,
      readVersion: () => doc.version,
      // The settle-time read. execute-write documents it as non-throwing and
      // calls it OUTSIDE any try — a seam that breaks that assumption (a
      // disposed document, a broken canonicaliser) rejects the whole pipeline.
      readCanonical: () => {
        if (failSettle) {
          throw new Error("boom-settle");
        }
        return doc.text;
      },
      canonicalize: (text) => text,
      build: (span) => {
        attempts.push(span.insert);
        return {};
      },
      apply: async () => true,
    },
    openExternal: () => {},
  });

  return {
    errors,
    attempts,
    seedBuilds,
    state: () => live,
    armSettleFailure: (on: boolean) => {
      failSettle = on;
    },
    // One keystroke, shaped as the panel shapes it: base = the version the
    // webview last received, document snapshots read live at dispatch time.
    type: (content: string) => {
      dispatchEvent({
        type: "edit",
        baseDocVersion: live.lastAppliedDocVersion,
        content,
        documentVersion: doc.version,
        canWrite: true,
        currentContent: doc.text,
      });
    },
  };
}

describe("applyEdit settlement: a rejected write pipeline releases the host write lock", () => {
  it("the NEXT edit after a settle-time throw is still ATTEMPTED as a write", async () => {
    const h = harness();

    // Edit #1 — the apply lands but the settle-time canonical read throws, so
    // `executeDocumentWrite` REJECTS.
    h.armSettleFailure(true);
    h.type("a");
    await flushSettle();
    expect(h.attempts).toEqual(["a"]);

    // The failed settlement must still release the lock. Under the old one-armed
    // `.then` the rejection was swallowed and this stayed held forever.
    expect(isWriteLockHeld(h.state())).toBe(false);

    // ...and the user is TOLD the save failed (a non-ok settlement's toast),
    // rather than the panel silently going read-only.
    expect(h.errors.some((m) => m.includes("Failed to save"))).toBe(true);

    // Edit #2 — the settle-time read works again. THE assertion: with the lock
    // stranded this keystroke is stashed behind a bare console.warn and never
    // written, so `build` never runs and `attempts` stays at just ["a"].
    //
    // The subject here is deliberately narrow — that a second write is ATTEMPTED
    // at all. It does NOT settle cleanly: `apply` is a stub that never mutates
    // `doc`, so at edit #2 the settle-time canonical read still returns "" while
    // the intended content is "ab" → the write pipeline tags the outcome
    // `diverged` (an ok apply whose landed bytes differ), the core bumps
    // `externalEpoch` and logs the divergence. Making the fake actually apply
    // would NOT fix that: a non-ok settlement leaves `lastAppliedDocVersion` at 1
    // while `doc.version` advances to 2, so `type()`'s base no longer matches and
    // `decideEdit`'s strict `!==` rejects edit #2 as `stale` before it ever
    // reaches `build` — the write would stop being attempted, which is the very
    // thing this test exists to observe. A faithful harness would have to track
    // the version the fake webview last acked; that is a bigger change than the
    // regression is worth pinning.
    h.armSettleFailure(false);
    h.type("ab");
    await flushSettle();

    expect(h.attempts).toEqual(["a", "ab"]);
    expect(isWriteLockHeld(h.state())).toBe(false);
  });

  // The toast is the ONLY user-visible signal that a save failed, and the
  // rejection arm's own recovery is what puts it at risk: `settlementEffects`
  // orders the reseed first, and that reseed re-runs the broken read. Without a
  // guard around the settlement dispatch the reseed throws, `runEffects` unwinds
  // before reaching the `showError` effect, and the rejection is left unhandled —
  // the lock is released (state is committed before effects run) but the user is
  // told nothing, which is the silent-failure mode this whole file exists to
  // prevent.
  it("still reports the failure when the reseed throws on the same broken seam", async () => {
    const h = harness();

    h.armSettleFailure(true);
    h.type("a");
    await flushSettle();

    // Non-vacuity: the reseed really was attempted (and really threw) on this
    // path. If the harness ever stops routing `buildSeedDocument` through
    // `failSettle`, this goes red rather than passing for the wrong reason.
    expect(h.seedBuilds.length).toBeGreaterThan(0);

    expect(h.errors.filter((m) => m.includes("Failed to save"))).toHaveLength(1);
    expect(isWriteLockHeld(h.state())).toBe(false);
  });

  // The rejection arm settles with a PAIRED `""`/`""` (`currentContent` /
  // `preApplyContent`) because the read seams are what threw. That pairing is
  // load-bearing and only observable with a stash waiting: the non-ok
  // foreign-bytes check compares the two against each other, so equal empties
  // mean "nothing foreign intervened" and the epoch must NOT advance. Filling in
  // real bytes on one side only would bump it, and the reseed that follows would
  // invalidate the webview's replay buffer — dropping the very keystrokes the
  // toast tells the user to retry.
  it("a stash waiting at a rejected settlement is released without a spurious epoch bump", async () => {
    const h = harness();

    h.armSettleFailure(true);
    h.type("a");
    // SYNCHRONOUSLY, before the settlement resolves: the write lock is taken by
    // edit #1's `applyEdit` effect, so this second keystroke takes the stash
    // branch instead of a write of its own.
    h.type("ab");
    expect(isWriteLockHeld(h.state())).toBe(true);
    expect(h.state().pendingEdit).not.toBeNull();
    expect(h.attempts).toEqual(["a"]);
    const epochBefore = h.state().externalEpoch;

    await flushSettle();

    // The epoch assertion is unaffected by the reseed throwing mid-`runEffects`:
    // the harness (like the panel) commits the new state BEFORE running effects,
    // and nothing re-dispatches here, so the dispatcher queue drains empty.
    expect(h.state().externalEpoch).toBe(epochBefore);
    expect(h.state().pendingEdit).toBeNull();
    expect(isWriteLockHeld(h.state())).toBe(false);
    // A failed save never drains the stash — it surfaces as the toast instead,
    // exactly once.
    expect(h.errors.filter((m) => m.includes("Failed to save"))).toHaveLength(1);
  });
});
