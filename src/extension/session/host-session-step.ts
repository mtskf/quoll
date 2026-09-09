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
// Why a THROWING TRANSITION is settled too, but only on `applyEditSettled`:
// that transition unwinds before the panel commits the state it would have
// returned, so the write lock stays HELD and no second settlement is coming —
// the same stranding, reached one step earlier. The rescue is a FAILED verdict
// (`settle(false)`), because a `true` one consults the still-held lock and
// takes the barrier's WAIT arm. It must stay conditional: on any other event
// the lock belongs to an apply whose own settlement is still pending and will
// resolve legitimately through the barrier's own DRAIN / DROP / WAIT arms
// (`edit-settled-barrier.ts`'s `settle`), not through this rescue.
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
   *  effects to run. A throw here is NOT settled unconditionally: settling a
   *  step whose transition threw would hand the barrier a verdict for a step
   *  that never happened, and a blind `settle(false)` would DROP deferred
   *  thunks that a still-pending real settlement would otherwise resolve on
   *  its own terms — DRAIN, DROP, or WAIT, per `edit-settled-barrier.ts`'s
   *  `settle`. The rescue below is conditioned on the throwing event being the settlement
   *  itself — on the LIVE path (the panel still alive, still typed into) the
   *  only event that ever releases the lock (see `isEditApplied`'s
   *  `applyEditSettled` / `disposed` comment). A throw from the `disposed`
   *  transition needs no rescue of its own, but NOT because the barrier drops
   *  anything IN THIS STEP: the panel sets its local `disposed` flag BEFORE
   *  dispatching the `disposed` event (`quoll-editor-panel.ts`'s
   *  `onDidDispose`), so `editSettledBarrier`'s `isDisposed()` already reads
   *  true regardless of whether this transition throws. If an apply was in
   *  flight, THAT apply's own `applyEditSettled` step still arrives later
   *  (its dispatch fires post-dispose, in every outcome arm — see
   *  `effect-executor.ts`'s `runApplyEdit` header), and it is THAT later,
   *  independent step's call to `settleEditBarrier` — finding `isDisposed()`
   *  true — that drops the deferred thunks. The drop is real; it just rides
   *  the in-flight apply's own settlement, not this one. Today such a throw
   *  is defensive-only: the injected write validator is fail-closed
   *  (validate-for-write.ts turns parser throws into verdicts), which leaves
   *  only the reducer's own exhaustive-arm throws. */
  readonly commitTransition: (event: HostSessionEvent) => readonly HostSessionEffect[];
  readonly runEffects: (effects: readonly HostSessionEffect[]) => void;
  /** `editSettledBarrier.settle` — the deferred side channels' ONLY release. */
  readonly settleEditBarrier: (applied: boolean) => void;
  /** Reports a throw from `settleEditBarrier` that would otherwise MASK the
   *  error it ran alongside — either a transition throw (the rescue settle in
   *  `rescueStrandedSideChannels` below) or an effect throw (the drain settle
   *  after `runEffects`). Defaults to console.error. */
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
      // Includes the UNVERIFIED landing (the event's `currentContent` is null —
      // the settle-time CONTENT read is what downgrades `applied` to
      // `appliedUnverified`): the write completed and only the verification read
      // broke (PR #399). A version-only read failure is NOT that case: it leaves
      // the tag `applied` and only gates the ack label, so `settledVersion` says
      // nothing about whether the edit was applied.
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

/** True iff a throw from `commitTransition(event)` leaves the write lock
 *  (`pendingApplyBaseVersion`) HELD with no future settlement ever coming —
 *  the one case the rescue below must cover. Exhaustive over
 *  `HostSessionEvent["type"]`, same idiom as `isEditApplied`'s outer switch:
 *  a new union member must answer this explicitly instead of silently
 *  falling through to "no rescue needed", which would reintroduce the exact
 *  stranding this module exists to fix. `disposed` answers false: if no apply
 *  was in flight, the lock was not held and there is nothing to strand; if one
 *  WAS in flight, its own `applyEditSettled` step still arrives later
 *  regardless of whether this `disposed` transition throws (that dispatch
 *  fires post-dispose, in every outcome arm — see `effect-executor.ts`'s
 *  `runApplyEdit` header). By the time THAT step calls `settleEditBarrier`,
 *  the panel's local `disposed` flag is already true (set before the
 *  `disposed` event is dispatched — `quoll-editor-panel.ts`'s
 *  `onDidDispose`), so the barrier's own `isDisposed()` check
 *  (`edit-settled-barrier.ts`) drops the deferred thunks there — a later,
 *  independent step, not this one. So no rescue is needed for a throw from
 *  `disposed` itself. */
function releasesWriteLockOnCommit(event: HostSessionEvent): boolean {
  switch (event.type) {
    case "applyEditSettled":
      return true;
    case "seed":
    case "ready":
    case "edit":
    case "openExternal":
    case "documentChanged":
    case "themeChanged":
    case "viewStateVisible":
    case "editRejectedDeliveryFailed":
    case "disposed":
      return false;
    default: {
      const _exhaustive: never = event;
      console.error(
        "[quoll] unhandled HostSessionEvent while deciding whether a transition throw needs the write-lock rescue",
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

  const reportSettleError = (settleErr: unknown): void => {
    // The report is itself isolated — an injected reporter that throws (the
    // DEFAULT is a console call, which is exactly what a broken host
    // environment breaks) would otherwise escape and displace the error it was
    // reporting on.
    try {
      onSettleError(settleErr);
    } catch {
      // Deliberately inert: a second console call could fail for the same
      // reason this one did, and the caller's own error is the payload.
    }
  };

  /** Release the deferred side channels that a THROWING TRANSITION would
   *  otherwise strand. The transition unwound BEFORE the panel committed the
   *  state it would have returned. When the throwing event is the SETTLEMENT,
   *  that leaves the write lock (`pendingApplyBaseVersion`) HELD with no second
   *  settlement ever coming: the deferred side channels would sit in the
   *  barrier forever and their at-receipt guards (the Codex single-flight)
   *  would never release. `settle(false)` is the ONLY verdict that can free
   *  them, since `true` consults the still-held lock and takes the barrier's
   *  WAIT arm instead of dropping anything.
   *
   *  What this rescue pays for is a ONE-SHOT guard/thunk release, not a
   *  "retry works now" fix: it never clears `pendingApplyBaseVersion`
   *  (releasing the lock itself is a separate follow-up), so a side channel
   *  that retries lands in `editSettledBarrier.run()`, finds the lock still
   *  held, and re-defers behind it — stranded again until dispose.
   *
   *  Conditioned on the settlement for a reason: on any other event, if the
   *  lock is held it is held by an apply whose own settlement is still coming
   *  (see `releasesWriteLockOnCommit`'s doc), and that later, independent
   *  settlement is the legitimate resolution, via one of `edit-settled-barrier.ts`'s
   *  `settle` arms: DRAIN (run them) if it lands applied on the live path, DROP
   *  them (a single arm covering two causes — the apply failed, or `disposed`
   *  won the race first, both read as `deps.isDisposed() || !applied`), or WAIT
   *  if a stash-drain re-acquired the lock. Rescuing here, ahead of that
   *  resolution, would destroy work the barrier still owes — either running the
   *  thunks or releasing their at-receipt guards through `onDrop`. */
  const rescueStrandedSideChannels = (event: HostSessionEvent): void => {
    if (!releasesWriteLockOnCommit(event)) {
      return;
    }
    try {
      deps.settleEditBarrier(false);
    } catch (settleErr) {
      // Same rule as the effect-throw path in the step below: the recovery must
      // not step on the failure it is recovering from. The transition error is
      // the root cause and the triage payload, so it is the one that propagates
      // (the caller rethrows it right after this returns).
      reportSettleError(settleErr);
    }
  };

  return (event: HostSessionEvent): void => {
    let effects: readonly HostSessionEffect[];
    try {
      effects = deps.commitTransition(event);
    } catch (transitionErr) {
      rescueStrandedSideChannels(event);
      throw transitionErr;
    }
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
      // so it wins; this one is reported rather than swallowed.
      reportSettleError(settleErr);
    }
    if (effectsError !== null) {
      throw effectsError.err;
    }
  };
}
