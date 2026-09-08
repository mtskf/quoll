// One host-session reducer step: transition → commit state → run effects →
// release the edit-settled barrier.
//
// Why this is a module and not just four lines in the panel closure: the
// barrier's `settle` is the deferred side channels' SOLE release site, and the
// panel closure is vscode-bound, so the branch that matters most — the one
// where `runEffects` THROWS — had no unit-test reach. Same move, same reason as
// the earlier extractions of `effect-executor.ts`, `edit-settled-barrier.ts` and
// `createDrainingDispatcher`, each of which got direct tests that way.
//
// Why the settle is UNCONDITIONAL: `runEffects` throwing used to skip it, so a
// side-channel thunk deferred behind the write lock (context-handoff /
// codex-context-handoff / switch-to-text) was neither dropped per the barrier's
// failed-apply contract nor drained — it survived and ran at the NEXT settle,
// against a document this edit never landed in. The verdict comes from the
// EVENT (see `isEditApplied`), so it does not care which effects completed.
//
// Why this is NOT a bare `try/finally`: a throw from the settle would then
// REPLACE the effect error and take the triage payload with it. Same rule as
// docs/LEARNING.md 2026-08-09 — the recovery path must not step on the failure
// it is recovering from. The ordering here is explicit instead: the effect error
// wins, the settle error is reported, and the reporter's own failure cannot
// displace either.

import type { HostSessionEffect, HostSessionEvent } from "./host-session-core.js";

export interface HostSessionStepDeps {
  /** Run the reducer transition and COMMIT the resulting state; returns the
   *  effects to run. Deliberately OUTSIDE the settle guard below: settling a
   *  step whose transition threw would hand the barrier a verdict for a step
   *  that never happened — and a blind `settle(false)` here could DROP deferred
   *  thunks that a still-pending real settlement would legitimately drain.
   *  KNOWN COST, accepted for now (this is NOT "nothing is lost"): if an
   *  `applyEditSettled` transition itself throws, the write lock stays HELD
   *  with no settlement coming, stranding the deferred side channels — neither
   *  dropped nor drained. Tracked in docs/TODO.md. Today that throw is
   *  defensive-only: the injected write validator is fail-closed
   *  (validate-for-write.ts turns parser throws into verdicts), which leaves
   *  only the reducer's own exhaustive-arm throws. */
  readonly commitTransition: (event: HostSessionEvent) => readonly HostSessionEffect[];
  readonly runEffects: (effects: readonly HostSessionEffect[]) => void;
  /** `editSettledBarrier.settle` — the deferred side channels' ONLY release. */
  readonly settleEditBarrier: (applied: boolean) => void;
  /** Reports a throw from `settleEditBarrier` that would otherwise MASK an
   *  effect throw. Defaults to console.error. */
  readonly onSettleError?: (err: unknown) => void;
}

/** The barrier verdict for `event`: false ⇔ this step is a FAILED apply
 *  settlement, whose deferred side channels must be DROPPED (the edit did not
 *  land, so they would read pre-edit bytes). Exhaustive over BOTH discriminants
 *  — `HostSessionEvent["type"]` and `ApplyEditOutcome["kind"]` — on purpose: a
 *  new member must make this decision explicitly, and the `never` assignment
 *  turns "forgot to" into a `pnpm compile` error instead of leaving it to the
 *  conservative default arm, which logs and reports the member as NOT applied —
 *  correct for a failure, but a DROP of the deferred side channels for a
 *  landing that actually succeeded. */
export function isEditApplied(event: HostSessionEvent): boolean {
  switch (event.type) {
    // Not apply settlements, so none of these deliver a failed-apply verdict.
    // An apply MAY still be in flight when several of these arrive (a
    // lock-held `edit` stash, a `documentChanged` echo of the in-flight
    // apply, a lock-held `ready`/`viewStateVisible`) — `true` then lets
    // `settle` fall into its own WAIT arm (still locked), never DRAIN, since
    // only `applyEditSettled` (settled in this same step) and `disposed`
    // (dropped via the barrier's own `isDisposed` check) ever release the lock.
    case "seed":
    case "ready":
    case "edit":
    case "openExternal":
    case "documentChanged":
    case "themeChanged":
    case "viewStateVisible":
    case "editRejectedDeliveryFailed":
    case "disposed":
      return true;
    case "applyEditSettled":
      break;
    default: {
      const _exhaustive: never = event;
      console.error(
        "[quoll] unhandled HostSessionEvent for the barrier verdict; treating the edit as NOT applied",
        _exhaustive
      );
      return false;
    }
  }
  switch (event.outcome.kind) {
    case "ok":
      // Includes the UNVERIFIED landing (`documentVersion: null`): the write
      // completed and only the verification read broke (PR #399).
      return true;
    case "refused":
    case "constructThrew":
    case "applyThrew":
    case "rejected":
      return false;
    default: {
      const _exhaustive: never = event.outcome;
      console.error(
        "[quoll] unhandled ApplyEditOutcome kind; treating the edit as NOT applied",
        _exhaustive
      );
      return false;
    }
  }
}

export function createHostSessionStep(
  deps: HostSessionStepDeps
): (event: HostSessionEvent) => void {
  const onSettleError =
    deps.onSettleError ??
    ((err: unknown) => console.error("[quoll] edit-settled barrier threw", err));

  return (event: HostSessionEvent): void => {
    const effects = deps.commitTransition(event);
    // Read the verdict from the EVENT: it must survive a throwing effect list,
    // and it depends on nothing the effects touch.
    const editApplied = isEditApplied(event);
    // Boxed so a thrown `undefined` / `null` is still distinguishable from
    // "the effects completed".
    let effectsError: { readonly err: unknown } | null = null;
    try {
      deps.runEffects(effects);
    } catch (err) {
      effectsError = { err };
    }
    try {
      deps.settleEditBarrier(editApplied);
    } catch (settleErr) {
      if (effectsError === null) {
        throw settleErr;
      }
      // Both threw: the effect error is the root cause and the triage payload,
      // so it wins; this one is reported rather than swallowed. The report is
      // itself isolated — an injected reporter that throws (the DEFAULT is a
      // console call, which is exactly what a broken host environment breaks)
      // would otherwise escape here and displace the error it was reporting on.
      try {
        onSettleError(settleErr);
      } catch {
        // Deliberately inert: a second console call could fail for the same
        // reason this one did, and the effect error thrown below is the payload.
      }
    }
    if (effectsError !== null) {
      throw effectsError.err;
    }
  };
}
