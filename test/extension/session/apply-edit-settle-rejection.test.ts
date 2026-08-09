// @vitest-environment node
//
// Regression pin for the stranded host write lock: `runApplyEdit` used to attach
// only an `onFulfilled` arm (`void executeDocumentWrite(…).then(ok)`), so a
// REJECTED write pipeline was swallowed by the `void`. `applyEditSettled` is the
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
    buildSeedDocument: (docVersion, externalEpoch, epochGeneration) =>
      ({
        protocol: 1,
        type: "document",
        content: doc.text,
        docVersion,
        canWrite: true,
        themeKind: "light",
        externalEpoch,
        epochGeneration,
      }) as HostToWebview,
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
  it("the NEXT edit after a settle-time throw still reaches the document", async () => {
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

    // Edit #2 — a healthy pipeline again. THE assertion: with the lock stranded
    // this keystroke is stashed behind a bare console.warn and never written, so
    // `build` never runs and `attempts` stays at just ["a"].
    h.armSettleFailure(false);
    h.type("ab");
    await flushSettle();

    expect(h.attempts).toEqual(["a", "ab"]);
    expect(isWriteLockHeld(h.state())).toBe(false);
  });
});
