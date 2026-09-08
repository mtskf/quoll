// One host-session reducer step: transition → commit state → run effects →
// release the edit-settled barrier.
//
// Why this is a module and not just four lines in the panel closure: the
// barrier's `settle` is the deferred side channels' SOLE release site, and the
// panel closure is vscode-bound, so the branch that matters most — the one
// where `runEffects` THROWS — had no unit-test reach. The same extraction gave
// `effect-executor.ts`, `edit-settled-barrier.ts` and `createDrainingDispatcher`
// their direct tests.
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
   *  effects to run. Deliberately OUTSIDE the settle guard below: a transition
   *  throw means no effect ran and the lock state is unchanged, so there is
   *  nothing to release — and settling anyway would hand the barrier a verdict
   *  for a step that never happened. */
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
 *  land, so they would read pre-edit bytes). Exhaustive over
 *  `ApplyEditOutcome["kind"]` on purpose: a new kind must make this decision
 *  explicitly, and the `never` assignment turns "forgot to" into a
 *  `pnpm compile` error rather than a silent drain. */
export function isEditApplied(event: HostSessionEvent): boolean {
  if (event.type !== "applyEditSettled") {
    return true;
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
