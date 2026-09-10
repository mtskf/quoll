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
// (`settle(false)`) because the recovery below has ALREADY RELEASED the lock by
// then, so `true` would DRAIN the thunks against a document whose edit may
// never have landed — and the recovery is outcome-blind, so it cannot say. It
// must stay conditional: on any other event the lock belongs to an apply whose
// own settlement is still pending and will resolve legitimately through the
// barrier's own DRAIN / DROP / WAIT arms (`edit-settled-barrier.ts`'s `settle`),
// not through this rescue.
//
// Since the follow-up slice, that same catch ALSO commits the write-lock
// recovery (`settlementTransitionFailed`) BEFORE it settles: the barrier drop
// only releases the deferred thunks' at-receipt guards, and without releasing
// the LOCK that release was one-shot — a retried side channel re-deferred
// behind a lock nothing would ever release, and every later edit piled into a
// stash with no drain.
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
   *  `settle`. The rescue below is conditioned on the throwing event being the
   *  settlement itself — the only INBOUND event whose NORMAL commit releases the
   *  lock on the LIVE path (the panel still alive, still typed into). "Inbound"
   *  is the load-bearing word and it now has a type behind it
   *  (`HostSessionInputEvent`): the other live release site,
   *  `settlementTransitionFailed`, IS this rescue's own commit — never
   *  dispatched, so it can never arrive here as a throwing INPUT (see
   *  `host-session-core.ts:1215`, "THE SECOND LIVE WRITE-LOCK RELEASE SITE").
   *  When the settlement's commit THREW, that recovery is what releases the lock
   *  (see `isEditApplied`'s `applyEditSettled` / `disposed` comment). A throw from the
   *  `disposed` transition needs no rescue of its own, but NOT because the barrier drops
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
   *  only the reducer's own exhaustive-arm throws.
   *
   *  A throw from `applyEditSettled` itself IS paid, but not here: see
   *  `commitWriteLockRecovery` and `recoverStrandedWriteLock`, which release the
   *  write lock and dispose of the stash before the barrier is settled. */
  readonly commitTransition: (event: HostSessionEvent) => readonly HostSessionEffect[];
  /** Commit the `settlementTransitionFailed` recovery transition and return its
   *  effects — the panel's own state-committing lambda, called with the THROWING
   *  SETTLEMENT's `settledVersion` so the recovery re-bases on the label that
   *  settlement already observed (no second version read anywhere; see the event
   *  member's comment in `host-session-core.ts`). REQUIRED, not optional: a
   *  no-op default would let a call site forget the wiring and keep the
   *  stranded-lock bug with every test green — measured, `?` plus a
   *  `?? (() => [])` default leaves all 335 `test/extension/session` tests
   *  passing. So the modifier is PINNED, in
   *  `test/extension/types-equality.test.ts` (this file's own suite is in no
   *  tsconfig, which is why the pin cannot live next to it). */
  readonly commitWriteLockRecovery: (settledVersion: number | null) => readonly HostSessionEffect[];
  readonly runEffects: (effects: readonly HostSessionEffect[]) => void;
  /** `editSettledBarrier.settle` — the deferred side channels' ONLY release. */
  readonly settleEditBarrier: (applied: boolean) => void;
  /** Reports a throw that would otherwise MASK the error it ran alongside:
   *  from `settleEditBarrier` (the rescue settle in
   *  `rescueStrandedSideChannels` below, or the drain settle after
   *  `runEffects`) or from the write-lock recovery `recoverStrandedWriteLock`
   *  runs beside it (its commit or its effects). ONE channel for all of them on
   *  purpose — every caller has the same contract: report, never propagate,
   *  never displace the root cause. Defaults to console.error. */
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
    // only `applyEditSettled` (settled in this same step), the
    // `settlementTransitionFailed` recovery committed when that settlement's
    // transition THREW, and `disposed` (dropped via the barrier's own
    // `isDisposed` check) ever release the lock.
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
    // The write-lock recovery: outcome-blind by design, so it can never claim
    // the edit landed. `false` ⇒ DROP the deferred side channels, the same
    // verdict the throwing settlement's own rescue passes. Today the recovery is
    // committed directly from the step's catch rather than stepped, so this is
    // the safe answer for a future call site that DOES step it.
    case "settlementTransitionFailed":
      return false;
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

/** The one event whose commit-throw needs rescuing — what
 *  `releasesWriteLockOnCommit` hands back when it selects one. */
type SettlementEvent = Extract<HostSessionEvent, { readonly type: "applyEditSettled" }>;

/** Non-null iff a throw from `commitTransition(event)` WOULD leave the write
 *  lock (`pendingApplyBaseVersion`) held with no future settlement ever coming —
 *  the one case the two recoveries below must cover (`recoverStrandedWriteLock`
 *  releases the lock and disposes of the stash; `rescueStrandedSideChannels`
 *  drops the deferred thunks). It RETURNS THE EVENT rather than a boolean so
 *  the settlement's `settledVersion` reaches `recoverStrandedWriteLock` through
 *  the same decision that selected it: a boolean forced the caller to restate
 *  "this is the settlement" with its own `event.type === …` ternary, and a
 *  future member added to the non-null arm would have kept inheriting that
 *  ternary's `null` fallback silently (measured by moving
 *  `settlementTransitionFailed` into the arm below: with the boolean signature
 *  tsc stays CLEAN, with this one it is `TS2322` — the member is "missing the
 *  following properties … outcome, canWrite, currentContent, preApplyContent").
 *  NOT a `event is Extract<…>` type predicate: a predicate body is
 *  UNCHECKED, which would turn today's safe restatement into an unsound
 *  narrowing — strictly worse than the boolean it replaces.
 *
 *  Exhaustive over `HostSessionEvent["type"]`, same idiom as `isEditApplied`'s
 *  outer switch: a new union member must answer this explicitly instead of
 *  silently falling through to "no rescue needed", which would reintroduce the
 *  exact stranding this module exists to fix. `disposed` answers `null`: if no
 *  apply was in flight, the lock was not held and there is nothing to strand;
 *  if one WAS in flight, its own `applyEditSettled` step still arrives later
 *  regardless of whether this `disposed` transition throws (that dispatch
 *  fires post-dispose, in every outcome arm — see `effect-executor.ts`'s
 *  `runApplyEdit` header). By the time THAT step calls `settleEditBarrier`,
 *  the panel's local `disposed` flag is already true (set before the
 *  `disposed` event is dispatched — `quoll-editor-panel.ts`'s
 *  `onDidDispose`), so the barrier's own `isDisposed()` check
 *  (`edit-settled-barrier.ts`) drops the deferred thunks there — a later,
 *  independent step, not this one. So no rescue is needed for a throw from
 *  `disposed` itself. */
function releasesWriteLockOnCommit(event: HostSessionEvent): SettlementEvent | null {
  switch (event.type) {
    case "applyEditSettled":
      return event;
    // The recovery itself: `null` on purpose. Its arm is a pure field reset
    // with no `decideEdit`, no outcome switch and no document read — nothing
    // that can throw the way the settlement can — and rescuing it would make a
    // throwing recovery re-enter the very seam it is recovering from
    // (docs/LEARNING.md 2026-08-09), buying one more attempt at the same throw.
    // Not unbounded: `recoverStrandedWriteLock` wraps both its commit and its
    // effects in their own `try`, so the extra attempt is the only cost.
    case "settlementTransitionFailed":
    case "seed":
    case "ready":
    case "edit":
    case "openExternal":
    case "documentChanged":
    case "themeChanged":
    case "viewStateVisible":
    case "editRejectedDeliveryFailed":
    case "disposed":
      return null;
    default: {
      const _exhaustive: never = event;
      console.error(
        "[quoll] unhandled HostSessionEvent while deciding whether a transition throw needs the write-lock rescue",
        _exhaustive
      );
      return null;
    }
  }
}

export function createHostSessionStep(
  deps: HostSessionStepDeps
): (event: HostSessionEvent) => void {
  const onSettleError =
    deps.onSettleError ??
    ((err: unknown) =>
      console.error("[quoll] edit-settled barrier or write-lock recovery threw", err));

  const reportSecondaryError = (secondaryErr: unknown): void => {
    // The report is itself isolated — an injected reporter that throws (the
    // DEFAULT is a console call, which is exactly what a broken host
    // environment breaks) would otherwise escape and displace the error it was
    // reporting on.
    try {
      onSettleError(secondaryErr);
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
   *  would never release. The verdict must be `false`: the write-lock recovery
   *  committed just before this already RELEASED the lock, so `settle(true)`
   *  would take the barrier's DRAIN arm and RUN the thunks — and the recovery is
   *  outcome-blind, so it cannot establish that the edit landed. The choice here
   *  is DROP-vs-RUN, not DROP-vs-WAIT: `edit-settled-barrier.ts`'s `settle`
   *  evaluates `isDisposed() || !applied` BEFORE `isLocked()`, so a `true`
   *  verdict degrades to the WAIT arm only in the one corner where the recovery
   *  commit ITSELF threw and the lock is therefore still held. A DROP is right
   *  in both.
   *
   *  That release ordering is also what makes the drop DURABLE: a side channel
   *  that retries after its `onDrop` finds `isLocked()` false in
   *  `editSettledBarrier.run()` and executes immediately instead of
   *  re-deferring behind a lock nothing will ever release.
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
    if (releasesWriteLockOnCommit(event) === null) {
      return;
    }
    try {
      deps.settleEditBarrier(false);
    } catch (settleErr) {
      // Same rule as the effect-throw path in the step below: the recovery must
      // not step on the failure it is recovering from. The transition error is
      // the root cause and the triage payload, so it is the one that propagates
      // (the caller rethrows it right after this returns).
      reportSecondaryError(settleErr);
    }
  };

  /** Release the write lock a THROWING TRANSITION would otherwise strand.
   *  `commitTransition` unwound before the panel assigned the state it would
   *  have returned, so when the throwing event is the SETTLEMENT the lock
   *  (`pendingApplyBaseVersion`) stays HELD with no second settlement coming:
   *  every later inbound edit is stashed into a `pendingEdit` whose only drain
   *  is the settlement that already threw, and at dispose that stash is lost
   *  silently. Committing `settlementTransitionFailed` releases the lock,
   *  disposes of the stash, and reposts the authoritative Document.
   *
   *  The version it re-bases on is the throwing event's OWN `settledVersion`,
   *  passed through rather than re-read: it is the label the settlement itself
   *  would have used, nothing can interleave before the throw, and it keeps
   *  `effect-executor.ts`'s "ONE guarded version reader" contract true.
   *
   *  Committed DIRECTLY rather than dispatched: a dispatched recovery would
   *  queue BEHIND any sibling event already waiting in the drain, which would
   *  then take the lock-held stash arm only to have its stash dropped by the
   *  recovery landing afterwards. Direct commit releases the lock before
   *  anything else can observe it, and it keeps the dispatcher's contract
   *  ("one `step` ATTEMPT per accepted event") intact — this is part of the
   *  failing step, not a new event.
   *
   *  Isolated for the same reason as the settle: the transition error is the
   *  root cause and the triage payload, so neither the recovery commit nor its
   *  effects may displace it. */
  const recoverStrandedWriteLock = (event: HostSessionEvent): void => {
    // ONE decision, carried as a value — the gate and the version below both
    // come from this single call (why it returns the event rather than a
    // boolean: `releasesWriteLockOnCommit`'s doc). `settledVersion` may still be
    // `null`: that is the settlement's OWN unobserved label (⇒ the reducer
    // withholds the ack rather than pairing live bytes with a fabricated one),
    // not a fallback invented here.
    const settlement = releasesWriteLockOnCommit(event);
    if (settlement === null) {
      return;
    }
    let recoveryEffects: readonly HostSessionEffect[];
    try {
      recoveryEffects = deps.commitWriteLockRecovery(settlement.settledVersion);
    } catch (recoveryErr) {
      reportSecondaryError(recoveryErr);
      return;
    }
    try {
      deps.runEffects(recoveryEffects);
    } catch (effectErr) {
      reportSecondaryError(effectErr);
    }
  };

  return (event: HostSessionEvent): void => {
    let effects: readonly HostSessionEffect[];
    try {
      effects = deps.commitTransition(event);
    } catch (transitionErr) {
      // Lock FIRST, side channels second: the drop `rescueStrandedSideChannels`
      // performs is only durable once the lock is free.
      recoverStrandedWriteLock(event);
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
      reportSecondaryError(settleErr);
    }
    if (effectsError !== null) {
      throw effectsError.err;
    }
  };
}
