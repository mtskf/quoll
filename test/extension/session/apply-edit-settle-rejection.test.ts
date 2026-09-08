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
// The unit-level mapping (rejection → non-ok settlement, unobserved snapshots,
// guarded `canWrite`) is pinned in effect-executor.test.ts. THIS file wires the
// real reducer to the real executor so the assertion is the user-visible one:
// after a failed settlement the NEXT keystroke still reaches the document.
//
// SPLIT CONTRACT (since `settle()` became total). A settle-time read failure is
// no longer a pipeline rejection, so what the user sees depends on whether the
// WRITE failed:
//   - the write pipeline COMPLETED (the apply landed — or, on the no-op
//     short-circuit, nothing was submitted at all: `appliedUnverified` is not a
//     landing claim, per execute-write.ts's ⚠️ note at `settle`) and only the
//     verification read broke → an UNVERIFIED-ok
//     settlement: the lock is released, a triage warn is logged, and there is NO
//     "Failed to save" toast (reporting a write that succeeded as failed is the
//     defect this file now pins against) — but see the ack-label-gate caveat below:
//     the ABSENCE of a version observation is its own, separate signal.
//   - the write genuinely did NOT land (a refusal / a rejected apply / a throw in
//     the synchronous prefix) → the failure family is unchanged: toast, then the
//     authoritative reseed.
// A SECOND, different toast exists on the correlated arrangement: when the same
// broken seam also makes `buildSeedDocument` throw, the ack Document cannot be
// built, and the executor emits one latched "could not update the editor view"
// notification (latched per INCIDENT — a successful build re-arms it). That is a
// reseed-delivery failure at another layer.
// A THIRD trigger for that SAME latched toast (the ack-label gate,
// host-session-core's `ackLabelObserved`): when no source observed a post-apply
// version — the settle-time read AND the executor's dispatch retry both failed,
// AND no lock-held `documentChanged` arrived (`armVersionFailure` +
// `dropLockHeldDocumentChanged` below) — the settlement withholds its ack rather
// than pairing live bytes with a stale label, and reports through the SAME
// shared latch. So: never assert `h.errors` is empty under `armSettleFailure(true)`
// OR a withheld-ack arrangement (`armVersionFailure`); filter for the message you
// mean.

import { describe, expect, it, vi } from "vitest";

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
import { createEditSync } from "../../../src/webview/cm/edit-sync.js";

const ctx = { uriString: "file:///x.md", fsPath: "/x.md" };
const okValidate = () => ({ ok: true }) as const;

// Flush the executor's async settlement (executeDocumentWrite awaits the apply,
// then runApplyEdit's `.then` dispatches) — a handful of microtask turns.
const flushSettle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
};

// Reducer + executor wired as the panel wires them MINUS the barrier: the panel
// composes these through `createHostSessionStep` (commit → runEffects →
// unconditional `editSettledBarrier.settle`), pinned separately in
// host-session-step.test.ts. This file is about the reducer↔executor pair over a
// fake document whose settle-time canonical read can be armed to throw. `build`
// is the write ATTEMPT probe: it runs only once the reducer has ACCEPTED an edit and issued
// the `applyEdit` effect, so a stashed (lock-blocked) keystroke leaves no entry.
interface HarnessOptions {
  /** `workspace.applyEdit` resolves FALSE — a genuinely failed write, so the
   *  failure family (toast + reseed) is the expected behaviour. */
  applyRefuses?: boolean;
  /** The injected `showError` throws AFTER recording the attempt (models a window
   *  API failing while the host tears down). `errorAttempts` still counts it, so a
   *  test can distinguish "attempted" from "displayed". */
  showErrorThrows?: boolean;
  /** EVENT-DELIVERY-LOSS FAULT INJECTION, not production equivalence (Codex r2
   *  88): the apply LANDS (buffer + version bump) but the lock-held
   *  `documentChanged` is DROPPED. Production wiring dispatches that event
   *  IMMEDIATELY while the lock is held (revert-rescue-wiring bypasses the
   *  trailing debounce), so the usual case is covered by a lock-held resync —
   *  but that mitigation is incidental, not a contract (the prior plan's
   *  Established fact 2), and the ack-label gate exists for the fault where
   *  the event never arrives. This arm injects that fault. */
  dropLockHeldDocumentChanged?: boolean;
}

// `armSettleFailure` arms two different seams:
//   "read-only" — ONLY the executor's settle-time canonical read throws, so the
//                 reseed still builds and the webview really does get its
//                 Document (and really could post again).
//   true        — the CORRELATED case: the same broken seam also makes
//                 `buildSeedDocument` throw, as it does in production where both
//                 bottom out in `canonicalDocumentText(document)`.
type SettleFailureMode = boolean | "read-only";

function harness(options: HarnessOptions = {}) {
  const core = createHostSessionCore(ctx, { validateForWrite: okValidate });
  const doc = { version: 1, text: "" };
  const attempts: string[] = [];
  const errors: string[] = [];
  const seedBuilds: string[] = [];
  const documents: { docVersion: number; externalEpoch: number; epochGeneration: number }[] = [];
  let errorAttempts = 0;
  let settleFailure: SettleFailureMode = false;
  // The executor's SYNCHRONOUS prefix. Since `settle()` became total this is the
  // one remaining way to make `executeDocumentWrite` REJECT, and so the only way
  // this file can reach `runApplyEdit`'s rejection arm — the write lock's sole
  // release valve on that path.
  let readTextFailure = false;
  let versionFailures = 0; // remaining readVersion calls that will throw (0 = healthy)
  // The span the last `build` produced — `apply` replays it against the live
  // buffer so the fake document really LANDS the edit (version bump included),
  // which is what makes an ok settlement carry a live version.
  let pendingSpan: { from: number; to: number; insert: string } | null = null;

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
    showError: (message) => {
      errorAttempts += 1;
      errors.push(message);
      if (options.showErrorThrows) {
        throw new Error("toast failed");
      }
    },
    canWrite: () => true,
    // Gated on the SAME `settleFailure` flag as `readCanonical` on purpose: in
    // production both bottom out in `canonicalDocumentText(document)` (the panel
    // wires `buildSeedDocument` → `canonicalDocumentText` and
    // `applyEditSeam.readCanonical` → the same function), so a seam that breaks
    // the settle-time read breaks the reseed too. A harness that reads a plain
    // `doc.text` here would decouple the two and hide the correlated failure:
    // the settlement's reseed throws mid-`runEffects`, and whether the user still
    // hears about the failed save then depends entirely on `settlementEffects`
    // putting the toast BEFORE the reseed.
    buildSeedDocument: (docVersion, externalEpoch, epochGeneration) => {
      seedBuilds.push(`v${docVersion}`);
      if (settleFailure === true) {
        throw new Error("boom-seed");
      }
      documents.push({ docVersion, externalEpoch, epochGeneration });
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
      readText: () => {
        if (readTextFailure) {
          throw new Error("boom-read");
        }
        return doc.text;
      },
      readVersion: () => {
        if (versionFailures > 0) {
          versionFailures -= 1;
          throw new Error("boom-version");
        }
        return doc.version;
      },
      // The settle-time verification read. execute-write GUARDS it individually,
      // so a broken seam (a disposed document, a broken canonicaliser) yields an
      // UNVERIFIED settlement rather than rejecting the whole pipeline.
      readCanonical: () => {
        if (settleFailure !== false) {
          throw new Error("boom-settle");
        }
        return doc.text;
      },
      canonicalize: (text) => text,
      build: (span) => {
        attempts.push(span.insert);
        pendingSpan = { from: span.from, to: span.to, insert: span.insert };
        return {};
      },
      // A FAITHFUL apply: it LANDS the built span into the fake buffer, bumps the
      // version, and — mirroring revert-rescue-wiring's lock-held branch — feeds
      // the reducer a `documentChanged` IMMEDIATELY, before resolving. VS Code
      // fires that change event before the applyEdit promise resolves, so the
      // reducer usually already holds the new version at settlement time.
      apply: async () => {
        if (options.applyRefuses) {
          return false;
        }
        if (pendingSpan !== null) {
          doc.text =
            doc.text.slice(0, pendingSpan.from) +
            pendingSpan.insert +
            doc.text.slice(pendingSpan.to);
          pendingSpan = null;
        }
        doc.version += 1;
        if (!options.dropLockHeldDocumentChanged) {
          dispatchEvent({ type: "documentChanged", documentVersion: doc.version });
        }
        return true;
      },
    },
    openExternal: () => {},
  });

  return {
    errors,
    attempts,
    seedBuilds,
    documents,
    /** Every `showError` CALL, counted even when the injected toast throws — so a
     *  test can tell "attempted once" from "displayed once". */
    get errorAttempts() {
      return errorAttempts;
    },
    state: () => live,
    /** The live document version the fake buffer is actually at. */
    docVersion: () => doc.version,
    /** The identity triple a webview would have from the last seed — what
     *  `edit-sync` stamps its buffered keystrokes with. */
    identity: () => ({
      docVersion: live.lastAppliedDocVersion,
      externalEpoch: live.externalEpoch,
      epochGeneration: live.epochGeneration,
    }),
    armSettleFailure: (mode: SettleFailureMode) => {
      settleFailure = mode;
    },
    /** Break the executor's SYNCHRONOUS prefix, which is what makes
     *  `executeDocumentWrite` REJECT rather than resolve. */
    armReadTextFailure: (on: boolean) => {
      readTextFailure = on;
    },
    /** Arm the NEXT n readVersion calls to throw (settle read = 1st, dispatch
     *  retry = 2nd). n=1 models a TRANSIENT failure the retry recovers; n>=2 a
     *  PERSISTENT one that reaches the withhold branch. */
    armVersionFailure: (n: number) => {
      versionFailures = n;
    },
    /** A FOREIGN edit, on the panel's real path for one: mutate the buffer, bump
     *  the version, and dispatch `documentChanged` LOCK-FREE. This is the only
     *  honest way to re-trigger a reseed after a correlated failure — the webview
     *  never got its Document, so its single-flight `editInFlight` is still set
     *  and a real one could not post another Edit. */
    externalEdit: (text: string) => {
      doc.text = text;
      doc.version += 1;
      dispatchEvent({ type: "documentChanged", documentVersion: doc.version });
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

describe("applyEdit settlement: a settle-time read failure releases the host write lock", () => {
  it("the NEXT edit after a settle-time throw is still ATTEMPTED as a write", async () => {
    const h = harness();

    // Edit #1 — the apply LANDS and only the settle-time canonical read throws.
    // "read-only" (not the correlated arm) on purpose: the reseed still builds, so
    // the webview really does get its Document and really could post again, which
    // is what makes the second keystroke below a sequence a user can produce.
    h.armSettleFailure("read-only");
    h.type("a");
    await flushSettle();
    expect(h.attempts).toEqual(["a"]);

    // The unverified settlement must still release the lock. Under the old
    // one-armed `.then` the rejection was swallowed and this stayed held forever.
    expect(isWriteLockHeld(h.state())).toBe(false);

    // ...and the user is NOT told the save failed: the apply landed, only its
    // verification did not. Reporting a successful write as failed is the defect
    // this file now pins against.
    expect(h.errors.filter((m) => m.includes("Failed to save"))).toEqual([]);

    // Edit #2 — the settle-time read works again. THE assertion: with the lock
    // stranded this keystroke is stashed behind a bare console.warn and never
    // written, so `build` never runs and `attempts` stays at just ["a"].
    // `build` records the minimal SPAN's insert, so a faithful apply (which the
    // harness now performs) makes the second entry the delta "b".
    h.armSettleFailure(false);
    h.type("ab");
    await flushSettle();

    expect(h.attempts).toEqual(["a", "b"]);
    expect(isWriteLockHeld(h.state())).toBe(false);
  });

  // THE REJECTION ARM, end to end. Everything above drives an outcome the pipeline
  // RESOLVES — since `settle()` became total, a settle-time read failure no longer
  // rejects it. So the arm this whole file was written for (the `.then`'s second
  // argument, the write lock's only release valve on a rejected pipeline) is
  // reached from exactly one seam now: the SYNCHRONOUS prefix, before anything can
  // land. Measured: without this test, neutering the rejection arm leaves every
  // test in this file green, so the integration-level lock-release contract the
  // header claims was pinned nowhere but in the executor's own unit tests.
  it("a REJECTED pipeline (a throwing synchronous prefix) releases the lock and toasts once", async () => {
    const h = harness();

    h.armReadTextFailure(true);
    h.type("a");
    await flushSettle();

    // Non-vacuity: the write really was never attempted — `readText` throws before
    // `build` runs, so this is a rejection, not a resolved failure tag.
    expect(h.attempts).toEqual([]);
    // (1) the lock is released. Under the old one-armed `.then` the rejection was
    // left unhandled by `void` and this stayed held for the rest of the session.
    expect(isWriteLockHeld(h.state())).toBe(false);
    // (2) ...and a write that never happened IS reported as a failed save — the
    // rejection arm is telling the truth here, unlike the resolved settle-read
    // failures above.
    const toasts = h.errors.filter((m) => m.includes("Failed to save"));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toContain("boom-read");

    // (3) the user-visible consequence the file's header claims: the NEXT
    // keystroke still reaches the document. With the lock stranded it would be
    // stashed behind a bare console.warn and never written.
    h.armReadTextFailure(false);
    h.type("ab");
    await flushSettle();
    expect(h.attempts).toEqual(["ab"]);
    expect(isWriteLockHeld(h.state())).toBe(false);
  });

  // The CORRELATED arrangement of the same subject. Here the broken seam also
  // makes `buildSeedDocument` throw, so no Document reached the webview and its
  // single-flight `editInFlight` is still set — a real webview could not post
  // another Edit, so this test deliberately does NOT type again (that would
  // "prove" a recovery the user cannot reach). What it pins is what IS reachable:
  // the lock is released and a landed write is not reported as a failed save.
  it("a correlated settle-time throw releases the lock without a save-failure toast", async () => {
    const h = harness();

    h.armSettleFailure(true);
    h.type("a");
    await flushSettle();

    expect(h.attempts).toEqual(["a"]);
    expect(isWriteLockHeld(h.state())).toBe(false);
    expect(h.errors.filter((m) => m.includes("Failed to save"))).toEqual([]);
  });

  // The toast is the ONLY user-visible signal that a save failed, and the
  // settlement's own reseed is what puts it at risk: `buildSeedDocument` re-runs
  // the broken read and throws.
  //
  // ⚠️ What this test measures is CONTAINMENT, not order. Since `runEffects`'
  // `postDocument` case started catching the build throw and `break`ing, the
  // effect loop CONTINUES past the failed reseed, so the toast is delivered
  // whatever its position in the list. (Measured: reversing the `refused` arm's
  // effect order leaves every test in this file green; only
  // `host-session-core.test.ts`'s exact `toEqual` on the effect list goes red.)
  // The toast-before-reseed ORDER is a real invariant and it is still pinned —
  // just not here: `host-session-core.test.ts` owns it (`expectToastBeforeReseed`).
  // Do not "restore" an ordering assertion to this test; pin it there.
  it("still reports the failure when the reseed throws on the same broken seam", async () => {
    // Arranged over a GENUINELY failed apply now: a settle-read failure alone is
    // no longer a save failure, so it emits no toast to order against. The broken
    // read is kept armed because it is what makes `buildSeedDocument` throw.
    const h = harness({ applyRefuses: true });

    h.armSettleFailure(true);
    h.type("a");
    await flushSettle();

    // Non-vacuity: the reseed really was attempted (and really threw) on this
    // path. If the harness ever stops routing `buildSeedDocument` through
    // `settleFailure`, this goes red rather than passing for the wrong reason.
    expect(h.seedBuilds.length).toBeGreaterThan(0);

    expect(h.errors.filter((m) => m.includes("could not save"))).toHaveLength(1);
    expect(isWriteLockHeld(h.state())).toBe(false);
  });

  // A settlement whose content read threw carries an UNOBSERVED (`null`)
  // snapshot. That is load-bearing: the foreign-bytes check reads "not observed"
  // as NOT FOREIGN, so the epoch must NOT advance. Fabricating bytes instead
  // would bump it, and the reseed that follows would invalidate the webview's
  // replay buffer — dropping the very keystrokes the toast tells the user to
  // retry.
  //
  // The stash is not what makes the epoch check observable (`foreignAtSettle`
  // never reads it) — it is here to drive the OTHER half of the same settlement:
  // the release path with a stash present, which must drop the undrainable
  // keystroke, clear the lock, and still surface exactly one toast.
  it("a stash waiting at a failed settlement is released without a spurious epoch bump", async () => {
    // A genuinely failed apply: the toast below belongs to the FAILURE, not to
    // the unobserved snapshot (an unverified landing emits none).
    const h = harness({ applyRefuses: true });

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
    expect(h.errors.filter((m) => m.includes("could not save"))).toHaveLength(1);
  });
});

// CORRELATED FAILURE. In production the settle-time throw comes from
// `canonicalDocumentText(document)`, and `buildSeedDocument` bottoms out in the
// SAME function. Before `settle()` became total that pair landed in the GUARDED
// rejection arm; now the settlement is `ok`, so its ack `postDocument` re-runs
// the broken read on the UNGUARDED fulfilment arm — and `createDrainingDispatcher`
// has `try`/`finally` with no `catch`, so an escaping throw becomes an unhandled
// rejection with no toast and no triage log. (It would NOT skip the barrier: the
// panel's `step` settles unconditionally — see host-session-step.ts — but the ack
// Document is still lost, which is what these pins are about.)
// The guard lives in `effect-executor.ts`'s `postDocument` case; these are its
// pins.
describe("applyEdit settlement: the correlated reseed failure stays contained", () => {
  it("a correlated failure (the reseed throws on the same broken seam) is contained, not an unhandled rejection", async () => {
    const h = harness();
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.on("unhandledRejection", onUnhandled);
    try {
      h.armSettleFailure(true); // BOTH the settle read and buildSeedDocument throw
      h.type("a");
      await flushSettle();
      expect(h.seedBuilds.length).toBeGreaterThan(0); // non-vacuity: the reseed WAS attempted
      expect(rejections).toEqual([]); // ...and its throw did not escape
      // A `catch { break; }` that loses the triage payload would also satisfy the
      // assertion above, so pin the log itself.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to build the Document"),
        expect.anything()
      );
      expect(isWriteLockHeld(h.state())).toBe(false);
      // A landed write must not be reported as a FAILED SAVE. The reseed-delivery
      // toast is a different signal and is asserted in the next test.
      expect(h.errors.filter((m) => m.includes("Failed to save"))).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
    }
  });

  it("the correlated failure is not SILENT: at most ONE notification attempt per INCIDENT", async () => {
    // The delta this fix would otherwise introduce: before it, this scenario
    // produced a (wrong) "Failed to save" toast; an unverified landing has no
    // toast by design, so without this signal the user is told NOTHING while the
    // webview's single flight stalls.
    const h = harness();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.armSettleFailure(true);
      h.type("a");
      await flushSettle();
      // NOT a save-failure toast: `settlementEffects`' ok arm still emits none.
      // This one reports that the ack Document could not be BUILT, i.e. the editor
      // view could not be updated — a different failure at a different layer.
      expect(h.errors.filter((m) => m.includes("Failed to save"))).toEqual([]);
      expect(h.errors.filter((m) => m.includes("could not update the editor view"))).toHaveLength(
        1
      );
      // Re-trigger through a REAL host-side path (a foreign edit's lock-free
      // documentChanged): after the failed reseed the webview never got its
      // Document, so a real one could not post another Edit — `h.type()` here
      // would model a sequence the user cannot produce. The seam is still broken,
      // so this is the SAME incident and must stay latched.
      h.externalEdit("外部から書き換え");
      expect(h.errors.filter((m) => m.includes("could not update the editor view"))).toHaveLength(
        1
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a RECOVERED seam re-arms the latch: a second incident gets its own notification", async () => {
    // The complement of the pin above, and the reason the latch is per-incident
    // rather than per-session. A panel lives for hours; latching forever means one
    // transient early hiccup consumes the session's ONLY user-visible signal for a
    // state this module documents as one that must not be silent.
    const h = harness();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Incident 1.
      h.armSettleFailure(true);
      h.type("a");
      await flushSettle();
      expect(h.errors.filter((m) => m.includes("could not update the editor view"))).toHaveLength(
        1
      );

      // The seam RECOVERS: a successful build (driven from a real host-side path,
      // a foreign edit's lock-free documentChanged) proves it and re-arms.
      h.armSettleFailure(false);
      const postedBefore = h.documents.length;
      h.externalEdit("recovered");
      expect(h.documents.length).toBeGreaterThan(postedBefore); // non-vacuity: it really built

      // Incident 2 — a NEW failure after a proven recovery.
      h.armSettleFailure(true);
      h.externalEdit("broken again");
      expect(h.errors.filter((m) => m.includes("could not update the editor view"))).toHaveLength(
        2
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a THROWING toast is contained and not retried within the incident (the latch is spent on the attempt)", async () => {
    // The property latch-before trades away is "the user always gets told"; what it
    // must still guarantee is that failing to tell them cannot escape or repeat
    // while the seam stays broken. (Across incidents it CAN repeat — that is the
    // re-arm, pinned above; here the seam never recovers, so it must not.)
    const h = harness({ showErrorThrows: true });
    const rejections: unknown[] = [];
    const onUnhandled = (r: unknown) => rejections.push(r);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.on("unhandledRejection", onUnhandled);
    try {
      h.armSettleFailure(true);
      h.type("a");
      await flushSettle();
      expect(rejections).toEqual([]); // (a) did not escape
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed to report the reseed build failure"),
        expect.anything()
      ); // (b) recorded
      expect(h.errorAttempts).toBe(1); // the ONE attempt really happened
      const attemptsBefore = h.errorAttempts;
      h.externalEdit("外部から書き換え");
      expect(h.errorAttempts).toBe(attemptsBefore); // (c) never retried
    } finally {
      process.off("unhandledRejection", onUnhandled);
      errorSpy.mockRestore();
    }
  });

  it("a later SUCCESSFUL build still posts — the guard does not poison the reseed path", async () => {
    // The anti-deadlock property that IS guaranteed: once the seam recovers, the
    // next Document is built and posted, which is what un-sticks the webview's
    // single flight. (That the webview stays stalled while the seam stays broken
    // is a pre-existing consequence of no Document arriving, not something this
    // guard introduces.)
    //
    // ⚠️ The trigger must be a REAL host-side one. Calling `h.type(...)` again
    // would bypass the very gate under discussion: a real webview cannot post
    // another Edit while its `editInFlight` is still set. Drive it from an
    // external document change instead — the lock-free `documentChanged` the panel
    // dispatches for a foreign edit, which reposts the authoritative Document.
    const h = harness();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      h.armSettleFailure(true);
      h.type("a");
      await flushSettle();
      const postedBefore = h.documents.length;
      h.armSettleFailure(false);
      h.externalEdit("外部から書き換え"); // bumps doc.version + dispatches documentChanged
      expect(h.documents.length).toBeGreaterThan(postedBefore);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// CROSS-LAYER pins. The identity pair the host ACTUALLY emits is fed into a REAL
// `createEditSync` holding a buffered keystroke. A bumped `externalEpoch` trips
// edit-sync's `recordedEpoch > buf.epoch` rule and DROPS that buffer — the data
// loss this whole change exists to prevent.
describe("applyEdit settlement: a landed write is acked, not toasted", () => {
  it("a settle-time read failure after a LANDED apply is not reported as a failed save", async () => {
    const h = harness();
    h.armSettleFailure("read-only");
    h.type("a");
    await flushSettle();
    expect(h.errors).toEqual([]); // the apply landed — no false alarm
    expect(isWriteLockHeld(h.state())).toBe(false);
    expect(h.documents.at(-1)?.docVersion).toBe(h.docVersion()); // the ack carries the LIVE version
  });

  it("a genuinely FAILED apply still toasts, even when the settle read also throws", async () => {
    // Non-vacuity guard for the expectation flipped above.
    const h = harness({ applyRefuses: true });
    h.armSettleFailure("read-only");
    h.type("a");
    await flushSettle();
    expect(h.errors.some((m) => m.includes("could not save"))).toBe(true);
  });

  it("the webview replay buffer SURVIVES a settle-time read failure", async () => {
    const h = harness();
    let webviewDoc = "";
    const posted: { content: string; baseDocVersion: number }[] = [];
    const sync = createEditSync({
      getDoc: () => webviewDoc,
      post: (content, baseDocVersion) => {
        posted.push({ content, baseDocVersion });
        return true;
      },
      scheduleFlush: (run) => run(),
    });

    const seed = h.identity();
    // VACUITY HAZARD: if the seed snapshot carried no identity pair, edit-sync's
    // "both absent -> replay" legacy arm would replay REGARDLESS of any epoch move
    // and this test would pass for the wrong reason. Pin that the pair is present.
    expect(seed.epochGeneration).toEqual(expect.any(Number));
    expect(seed.externalEpoch).toEqual(expect.any(Number));
    sync.onHostSnapshot(seed.docVersion, true, seed.externalEpoch, seed.epochGeneration);

    webviewDoc = "a";
    sync.onLocalChange(); // posts edit #1 -> in flight
    webviewDoc = "ab";
    sync.onLocalChange(); // BUFFERED behind it, stamped with the current pair
    expect(posted).toEqual([{ content: "a", baseDocVersion: seed.docVersion }]);

    h.armSettleFailure("read-only");
    h.type("a");
    await flushSettle();

    const ack = h.documents.at(-1);
    if (ack === undefined) {
      throw new Error("the settlement posted no Document");
    }
    sync.onHostSnapshot(ack.docVersion, true, ack.externalEpoch, ack.epochGeneration);
    sync.onReducerCommit(false);

    expect(posted).toEqual([
      { content: "a", baseDocVersion: seed.docVersion },
      { content: "ab", baseDocVersion: ack.docVersion }, // THE assertion: it replayed
    ]);
    expect(ack.externalEpoch).toBe(seed.externalEpoch); // ...and why
  });

  it("NEGATIVE pin: the same wiring DOES drop the buffer when the epoch advances", () => {
    // Proves the pin above is not passing through edit-sync's pair-less legacy arm:
    // identical shape, but the ack carries `externalEpoch + 1`.
    const h = harness();
    let webviewDoc = "";
    const posted: { content: string; baseDocVersion: number }[] = [];
    const sync = createEditSync({
      getDoc: () => webviewDoc,
      post: (content, baseDocVersion) => {
        posted.push({ content, baseDocVersion });
        return true;
      },
      scheduleFlush: (run) => run(),
    });

    const seed = h.identity();
    sync.onHostSnapshot(seed.docVersion, true, seed.externalEpoch, seed.epochGeneration);
    webviewDoc = "a";
    sync.onLocalChange();
    webviewDoc = "ab";
    sync.onLocalChange();
    expect(posted).toHaveLength(1);

    sync.onHostSnapshot(seed.docVersion + 1, true, seed.externalEpoch + 1, seed.epochGeneration);
    sync.onReducerCommit(false);

    expect(posted).toHaveLength(1); // no replay
  });
});

describe("applyEdit settlement: the ack-label gate end to end", () => {
  it("an UNOBSERVABLE version withholds the mislabelled ack: no Document, one latched toast, lock released", async () => {
    const h = harness({ dropLockHeldDocumentChanged: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.armVersionFailure(2); // settle read AND dispatch retry
      const postedBefore = h.documents.length;
      h.type("a");
      await flushSettle();
      // The apply LANDED (live doc at v2) but no source observed a version — the
      // OLD behaviour posted live "a" bytes labelled docVersion 1, which the
      // webview would base an Edit on → stale → epoch bump → replay buffer drop.
      expect(h.docVersion()).toBe(2);
      expect(h.documents.length).toBe(postedBefore); // WITHHELD
      expect(h.state().lastAppliedDocVersion).toBe(1); // no fabricated advance
      expect(h.errors.filter((m) => m.includes("could not update the editor view"))).toHaveLength(
        1
      );
      expect(h.errors.filter((m) => m.includes("Failed to save"))).toEqual([]); // the write did not fail
      expect(isWriteLockHeld(h.state())).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a TRANSIENT version-read failure recovers through the dispatch retry: the ack posts at the live version", async () => {
    const h = harness({ dropLockHeldDocumentChanged: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.armVersionFailure(1); // settle read throws; the dispatch retry succeeds
      h.type("a");
      await flushSettle();
      expect(h.documents.at(-1)?.docVersion).toBe(h.docVersion()); // ack at LIVE v2
      expect(h.state().externalEpoch).toBe(0); // own +1 delta is not foreign
      expect(h.errors).toEqual([]); // no toast of any kind
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a lock-held documentChanged licenses the ack even when every version read fails", async () => {
    const h = harness(); // fault NOT injected: apply dispatches the lock-held documentChanged
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.armVersionFailure(2);
      h.type("a");
      await flushSettle();
      expect(h.documents.at(-1)?.docVersion).toBe(h.docVersion()); // label from the lock-held resync
      expect(h.errors).toEqual([]); // observed → no withhold toast
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("the withhold latch is per incident and shared: a recovered reseed re-arms it", async () => {
    const h = harness({ dropLockHeldDocumentChanged: true });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Incident 1: withheld ack → one toast.
      h.armVersionFailure(2);
      h.type("a");
      await flushSettle();
      expect(h.errors.filter((m) => m.includes("could not update the editor view"))).toHaveLength(
        1
      );
      // The seam recovers; a REAL host-side path (foreign edit → lock-free
      // documentChanged) posts a Document successfully, which re-arms the latch.
      const postedBefore = h.documents.length;
      h.externalEdit("recovered");
      expect(h.documents.length).toBeGreaterThan(postedBefore);
      // Incident 2: the webview reseeded (its single flight cleared), so a second
      // keystroke is a sequence a real webview can produce.
      h.armVersionFailure(2);
      h.type("recovered!");
      await flushSettle();
      expect(h.errors.filter((m) => m.includes("could not update the editor view"))).toHaveLength(
        2
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
