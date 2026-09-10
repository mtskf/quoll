// Pure host-session reducer for QuollEditorPanel.
//
// Why a reducer: the host's write-lock ordering, rejection barrier,
// resync rules, and applyEdit settlement all read/advance the SAME lock
// state. Keeping them in one typed transition table (rather than scattered
// across closure variables and async `.then` arms) is what makes the
// host ⇄ webview echo-loop / double-write invariants reviewable and
// directly unit-testable. The panel becomes VS Code event ⇄ core
// event/effect wiring; this module owns every state mutation.
//
// Purity: `transition` is a pure function of (state, event). Live VS Code
// inputs (document.version, canWriteNow(), canonical text, theme) are
// snapshotted by the wiring into the event; side effects are returned as
// SELF-CONTAINED data (HostSessionEffect[]) for the wiring to execute. The
// version a Document is stamped with is a core decision, so it travels on
// the effect (`docVersion`) — the executor never re-reads mutable state for
// it. Async outcomes (applyEdit settlement, edit-rejected delivery failure)
// and synchronous feedback (construct/apply throw) re-enter as feedback
// events, so no mutation escapes the table.

import type { MarkdownError } from "../../markdown/errors.js";
import {
  type ValidateForWriteResult,
  validateMarkdownForWrite,
} from "../../markdown/validate-for-write.js";
import type { ThemeKind } from "../../shared/protocol.js";
import { decideEdit } from "./edit-decision.js";

export interface HostSessionContext {
  readonly uriString: string;
  readonly fsPath: string;
}

export type RejectionState =
  | { readonly kind: "none" }
  | {
      readonly kind: "pending";
      readonly id: number;
      readonly content: string;
      readonly error: MarkdownError;
    };

export interface PendingEdit {
  readonly content: string;
  readonly baseDocVersion: number;
}

export interface HostSessionState {
  readonly context: HostSessionContext;
  readonly lastAppliedDocVersion: number;
  readonly pendingApplyBaseVersion: number | null;
  readonly disposed: boolean;
  readonly rejection: RejectionState;
  // Monotonic id stamped on each rejection DELIVERY so a delayed
  // `postEditRejected` delivery-failure (which re-enters async) can only clear
  // the delivery it was issued for. It is re-stamped on every (re-)delivery —
  // the initial `parse-failed` post AND each `ready`/`seed` replay — so a
  // stale failure can neither clobber a NEWER rejection B created after an
  // intervening resync (Codex N2) NOR re-clear the SAME rejection A after a
  // `ready` replay has freshly re-delivered its banner (Codex N6). Survives
  // the `none` state so ids are never reused.
  readonly nextRejectionId: number;
  // The latest inbound Edit that arrived while the write lock was held.
  // Stashed instead of dropped so it can drain on the in-flight apply's
  // settlement — the sub-ms "type one-more-char then close" data-loss race.
  // Latest wins. Survives the `disposed` transition so the post-dispose
  // settlement can drain it.
  readonly pendingEdit: PendingEdit | null;
  // The content of the apply currently holding the write lock (set on the
  // `edit` accept arm, cleared on settlement). At settlement the drain is
  // SAFE only when `currentContent === inFlightContent` — i.e. the apply
  // landed exactly its target and no external edit raced the apply→settle
  // window. A mismatch means an external edit interfered → drop the stash and
  // let the external change win (never clobber a newer on-disk edit).
  readonly inFlightContent: string | null;
  // Document identity pair carried on every Document post (S3a). The reducer
  // OWNS both (like `lastAppliedDocVersion`) so they travel on the
  // postDocument/postRejectedDraft effects as core decisions, never re-read by
  // the executor. `externalEpoch` advances (via `resyncLiveVersion` and the
  // settlement foreign-bytes check) whenever content changed by anything other
  // than the webview's own acked edit lineage; it starts at 0. `epochGeneration`
  // is minted ONCE at initialState and never changes within a session (identity,
  // not ordering). S3a plumbs them; the webview consumes them in S3b.
  readonly externalEpoch: number;
  readonly epochGeneration: number;
}

/** True while the host write lock is held — i.e. a flushed edit's
 *  `workspace.applyEdit` is in flight. Exported so wiring (the side-channel
 *  edit-settled barrier) can read the lock WITHOUT depending on the concrete
 *  `pendingApplyBaseVersion` field name — the write-lock predicate stays a
 *  single source of truth here in the reducer module. */
export function isWriteLockHeld(state: HostSessionState): boolean {
  return state.pendingApplyBaseVersion !== null;
}

export type ApplyEditOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "refused" }
  | { readonly kind: "constructThrew"; readonly message: string }
  | { readonly kind: "applyThrew"; readonly message: string }
  | { readonly kind: "rejected"; readonly message: string };

export type HostSessionEvent =
  | { readonly type: "seed"; readonly documentVersion: number }
  | { readonly type: "ready"; readonly documentVersion: number }
  | {
      readonly type: "edit";
      readonly baseDocVersion: number;
      readonly content: string;
      readonly documentVersion: number;
      readonly canWrite: boolean;
      readonly currentContent: string;
    }
  | { readonly type: "openExternal"; readonly href: string }
  | { readonly type: "documentChanged"; readonly documentVersion: number }
  | { readonly type: "themeChanged"; readonly themeKind: ThemeKind }
  | { readonly type: "viewStateVisible"; readonly documentVersion: number }
  | {
      readonly type: "applyEditSettled";
      readonly outcome: ApplyEditOutcome;
      // The settle-time OBSERVED document version — ONE representation for every
      // outcome kind (v9 unification: `outcome.documentVersion` and a separate
      // event field would let the self-advance and the ack gate read different
      // values). `null` ⇔ NOT OBSERVED: EVERY guarded version read this
      // settlement made failed. How many that is depends on the producer — TWO
      // on the resolved path (the pipeline's settle-time read plus the executor's
      // guarded dispatch retry), ONE on the pipeline-rejection arm, which never
      // reaches a settle read at all. Never a fabricated number —
      // the advance below is inside a `!== null` guard, so `null` cannot reach a
      // version assignment.
      readonly settledVersion: number | null;
      // Fresh live snapshots taken by the executor at settlement time so the
      // stash drain can re-run the FULL decideEdit gates (canWrite + canonical
      // current text) AND the epoch foreign-bytes check (site 2). Since S3a the
      // canonical settled content is read on EVERY settlement (the epoch verify
      // is unconditional — no skip-unless-stash), so `currentContent` is the
      // canonical settled document (the pre-S3a empty-when-no-stash optimisation
      // is gone; restoring it would drop the epoch verify).
      // `null` ⇔ NOT OBSERVED. Two producers send it: the executor's settle-time
      // CONTENT read threw (an UNVERIFIED settlement — the apply may well have
      // landed), and the pipeline-rejection arm, which has no trustworthy
      // snapshot at all and MUST NOT re-read (that would strand the lock on the
      // recovery path — the read seams are the candidate throw sources).
      // `null` is deliberate rather than a stand-in value: without OBSERVED
      // bytes the foreign-bytes check below falls back to the version-delta
      // evidence at site 2, and `canDrain` refuses to drain without an OBSERVED
      // equality. Sending fabricated bytes instead would flip `foreignAtSettle`
      // on a clean save, bump the epoch, and the resulting reseed would
      // invalidate the webview's replay buffer — silently dropping the very
      // keystrokes the failure toast tells the user to retry.
      // ACCEPTED RESIDUAL RISK, now TYPED rather than accidental and NARROWER
      // than before: the version-delta fallback (site 2) supplies positive
      // foreign evidence whenever the version moved beyond our own
      // contribution, so the residual narrows to "content unobserved AND delta
      // ≤ own contribution" — a foreign edit raced the apply but left the
      // version exactly where our own contribution would have. (It used to
      // fall out of the rejection arm's two equal empties; the same verdict is
      // now the explicit answer for "not observed".) In that narrower residual
      // the webview keeps its replay buffer live and can re-post over the
      // foreign edit on the user's retry. This is deliberate — the alternative
      // (re-reading the document to get honest bytes) goes through the seam that
      // just threw and strands the write lock, which is strictly worse. Note this
      // is about the EPOCH only; `null` reaching `decideEdit` is separately
      // impossible because `canDrain` requires an OBSERVED snapshot.
      readonly canWrite: boolean;
      readonly currentContent: string | null;
      // Canonical pre-apply document snapshot (the executor's `oldText`,
      // canonicalised). The settlement foreign-bytes check (site 2) uses it as
      // the baseline for a NON-OK outcome: a transiently failed save leaves the
      // document at the pre-apply content, so `currentContent === preApplyContent`
      // means nothing foreign intervened (the retry buffer must stay replayable);
      // a mismatch means a foreign edit raced the failed apply → epoch++. For an
      // OK outcome the baseline is `inFlightContent` instead, so this is unused.
      // ⚠️ NOT always the executor's snapshot: the pipeline-REJECTION producer
      // (effect-executor's rejection arm) has no trustworthy snapshot and MUST NOT
      // re-read, so it sends an INERT `""` placeholder rather than widening this
      // field to `string | null`. Inert because the sole reader (the non-ok
      // foreign-bytes compare below) sits inside the `observed !== null` conjunct,
      // which a rejection settlement — whose `currentContent` is `null` by
      // construction — can never satisfy. Keep it that way: if a future reader
      // moves outside that conjunct, this field must become nullable first,
      // because `""` there would read as an empty pre-apply document.
      readonly preApplyContent: string;
      // Plan S6 (finding #7): the verified write executor detected that the
      // landed content differs from the intended content on an `ok` apply — a
      // stale-offset splice (S5: desktop MISPLACES) OR an external edit that won
      // the apply→settle race. Undefined/false = no divergence was DETECTED,
      // which is TWO states, not one: a clean apply (the compare ran and matched)
      // OR an UNVERIFIED settlement (`appliedUnverified`, `currentContent === null`)
      // where no compare could run at all. The separate `observed === null`
      // handling below, not this flag, is what covers the second — do not read a
      // `false` here as proof of a clean apply and drop it as redundant. When true the
      // settlement routes through the ok-but-mismatch convergence shape (epoch++
      // + authoritative resync + a distinct diverged log, NO error toast — a
      // deliberate conflict resolution must not read as "save failed"). The resync
      // half still rides the ack-label gate: `diverged` proves the CONTENT read
      // succeeded, NOT the version read (`settle()` guards the two separately), so
      // an unobserved label swaps that Document for the withhold pair — the epoch
      // bump and the diverged log run either way. It is a
      // belt-and-braces annotation: a genuine divergence ALSO trips the byte
      // compare below, but driving convergence off the explicit flag keeps the
      // reducer honest even if the compare is inconclusive.
      readonly divergedAfterApply?: boolean;
    }
  | {
      readonly type: "editRejectedDeliveryFailed";
      readonly id: number;
      // `null` ⇔ the recovery read was unobserved (the executor's guarded
      // readVersionGuarded failed) — the arm clears the rejection (a stuck
      // pending rejection is the deadlock this event exists to break) but
      // WITHHOLDS the recovery reseed rather than fabricating a label.
      readonly documentVersion: number | null;
    }
  | {
      // A throwing `applyEditSettled` TRANSITION unwinds before the panel
      // commits the state that would have released the write lock (the panel's
      // `commitTransition` assigns `state` only on a normal return), so the lock
      // stays HELD with no second settlement coming. This event is that
      // recovery, committed from `host-session-step.ts`'s catch — NOT a VS Code
      // input. It carries no `ApplyEditOutcome` on purpose: the outcome switch
      // (`failureToasts`) is itself one of the throw sources being recovered
      // from, so the arm below stays outcome-blind.
      readonly type: "settlementTransitionFailed";
      // The THROWING SETTLEMENT's own `settledVersion`, passed through by the
      // step — NOT a fresh read. Same contract as there (`null` ⇔ NOT OBSERVED,
      // never a fabricated number) and the same value the successful settlement
      // would have used for its `advanced` label, so the recovery reproduces
      // that decision instead of re-deriving one. Nothing can interleave
      // between the event's construction and the throw (the executor builds it,
      // dispatches it, and the transition throws synchronously on the
      // single-threaded host), so it is also still the LIVE version here.
      // Reusing it keeps `effect-executor.ts`'s "ONE guarded version reader"
      // contract true: the recovery adds no read seam of its own.
      readonly settledVersion: number | null;
    }
  | { readonly type: "disposed" };

/** Every event a DISPATCHER may carry. `settlementTransitionFailed` is excluded
 *  BY CONSTRUCTION: it is COMMITTED directly from `host-session-step.ts`'s
 *  transition catch, never queued — a dispatched recovery would land BEHIND a
 *  sibling already waiting in the drain, which would then take the lock-held
 *  stash arm only to have its stash dropped by the recovery landing afterwards
 *  (`recoverStrandedWriteLock`'s doc). Until this type existed, that contract
 *  was prose only: injecting the dispatch into `effect-executor.ts` type-checked
 *  CLEAN (measured).
 *
 *  DERIVED with `Exclude`, not written out as a parallel union: a new member is
 *  then carried automatically and only the EXCLUSION has to be stated, so the
 *  two types cannot drift. `commitTransition` / `commitWriteLockRecovery` keep
 *  the WIDE `HostSessionEvent` — committing the recovery is the one legitimate
 *  path and must stay expressible. */
export type HostSessionInputEvent = Exclude<
  HostSessionEvent,
  { readonly type: "settlementTransitionFailed" }
>;

export type HostSessionEffect =
  | {
      readonly type: "postDocument";
      readonly docVersion: number;
      // The identity pair to stamp on the wire (S3a). Core-managed, self-
      // contained on the effect exactly like `docVersion` — the executor never
      // re-reads reducer state for them.
      readonly externalEpoch: number;
      readonly epochGeneration: number;
    }
  | {
      readonly type: "postRejectedDraft";
      readonly content: string;
      readonly error: MarkdownError;
      readonly docVersion: number;
      readonly externalEpoch: number;
      readonly epochGeneration: number;
      // The freshly re-stamped delivery id (Codex N6). The executor delivers
      // the replayed banner failure-aware via `sendEditRejected(error, id)`, so
      // a failed replay delivery re-enters as `editRejectedDeliveryFailed(id)`
      // and recovers — it never reads mutable state for the id.
      readonly id: number;
    }
  | { readonly type: "postEditRejected"; readonly error: MarkdownError; readonly id: number }
  | { readonly type: "postTheme"; readonly themeKind: ThemeKind }
  | { readonly type: "applyEdit"; readonly content: string; readonly baseDocVersion: number }
  | { readonly type: "showError"; readonly message: string }
  | { readonly type: "logWarn"; readonly message: string; readonly detail: Record<string, unknown> }
  | { readonly type: "openExternal"; readonly href: string }
  // User-visible signal for a withheld settlement ack; the executor latches it
  // per incident together with the reseed-build failure.
  | { readonly type: "showResyncFailure" };

export interface HostSessionResult {
  readonly state: HostSessionState;
  readonly effects: readonly HostSessionEffect[];
}

export interface HostSessionDeps {
  readonly validateForWrite?: (content: string) => ValidateForWriteResult;
  // Mint the per-host-session `epochGeneration` nonce. Injected so tests get a
  // deterministic identity; the production default is a counter-salted
  // timestamp (unique across sessions even within one millisecond). Called
  // exactly once, in `initialState`.
  readonly mintEpochGeneration?: () => number;
}

// Module-scoped salt so two sessions minted in the same millisecond still get
// distinct generations. Wraps well below the safe-integer ceiling (Date.now() *
// 1000 + salt stays < 2^53 until year ~micro-far-future). Identity only — never
// compared for order.
let epochGenerationSalt = 0;
function defaultMintEpochGeneration(): number {
  epochGenerationSalt = (epochGenerationSalt + 1) % 1000;
  return Date.now() * 1000 + epochGenerationSalt;
}

/** EOL-insensitive content equality shared by the `applyEditSettled` foreign-
 *  bytes, drain-eligibility, and ok-but-mismatch checks. One operand
 *  (`inFlightContent`) is raw webview bytes joined with the CM lineSeparator
 *  facet; the other (`currentContent`/`preApplyContent`) is canonicalised to
 *  `document.eol`. A pure byte compare would misread an EOL-only difference
 *  (a plain edit on a CRLF-eol doc whose webview facet is still LF) as
 *  foreign bytes. The `a === b` fast path keeps the common byte-identical
 *  settle allocation-free; the normalise runs only when the strings already
 *  differ. */
function contentMatches(a: string, b: string | null): boolean {
  // a is always a string here → a null operand never matches
  if (b === null) {
    return false;
  }
  return a === b || a.replace(/\r\n|\r|\n/g, "\n") === b.replace(/\r\n|\r|\n/g, "\n");
}

/** Resync `lastAppliedDocVersion` to the live document version, raising it as
 *  `max(old, live)` so a late/reordered event or a future call site passing a
 *  LOWER version can never REWIND it (one clamp, one test). The `externalEpoch`
 *  increment is gated INTERNALLY: it fires only on a genuine LOCK-FREE forward
 *  advance (`liveVersion > old && pendingApplyBaseVersion === null`) — a
 *  lock-free advance is FOREIGN by construction (no self-apply is in flight, so
 *  the webview did not produce it), whereas a lock-HELD advance is usually the
 *  in-flight apply's own echo and is adjudicated by the settlement check
 *  instead. This is ONE of the reducer's TWO version-raising paths; the other is
 *  the settlement advance (`advanced` — `Math.max` over `event.settledVersion`
 *  for EVERY outcome kind since this PR, clamp-consistent with this helper and
 *  no longer an ok-only exemption). There are exactly two, and the invariant
 *  test's allowed-RHS roster is what fences a third from appearing. */
function resyncLiveVersion(state: HostSessionState, liveVersion: number): HostSessionState {
  const raised = Math.max(state.lastAppliedDocVersion, liveVersion);
  const foreignAdvance =
    liveVersion > state.lastAppliedDocVersion && state.pendingApplyBaseVersion === null;
  return {
    ...state,
    lastAppliedDocVersion: raised,
    externalEpoch: foreignAdvance ? state.externalEpoch + 1 : state.externalEpoch,
  };
}

const NONE: RejectionState = { kind: "none" };

// Build a postDocument effect stamping the identity pair from the POST-transition
// state `s` (so any epoch++ made in the same transition rides the Document out).
const postDoc = (s: HostSessionState, docVersion: number): HostSessionEffect => ({
  type: "postDocument",
  docVersion,
  externalEpoch: s.externalEpoch,
  epochGeneration: s.epochGeneration,
});

// The withhold pair — what a settlement, or the `settlementTransitionFailed`
// recovery, emits INSTEAD of its ack Document when no source observed a
// post-apply version. Not silent WHILE THE PANEL IS ALIVE: the logWarn is the
// triage record and showResyncFailure is the user-visible signal, latched per
// incident by the EXECUTOR (the reducer is pure and cannot hold a latch) — the
// same latch as the reseed-build failure, so the two "webview could not be
// resynced" families cannot double-toast one incident. ⚠️ It is NOT the signal
// for a LOST EDIT: the recovery arm gates its own loss clause on this same
// withheld-ack condition, precisely because "could not resync" does not say
// that. On the path that reaches HERE — alive, ack withheld — that clause is the
// HEDGED one ("may not have been saved"), which deliberately reuses this pair's
// own `RESYNC_FAILURE_MESSAGE` phrasing so the two toasts cannot disagree about
// certainty when both appear. The DEFINITE wording belongs to the post-dispose
// branch, where this pair is never built at all (see the four routes below).
// POST-DISPOSE the pair never reaches the executor, by FOUR different routes:
// the no-stash arm (`state.disposed && state.pendingEdit === null`, the early
// return in the `applyEditSettled` case) builds only failure toasts, so the pair
// is not even constructed; the undrainable arm keeps only `showError`s from the
// settlement effects; a stash that DRAINS post-dispose never calls
// `ackEffects` at all (the drain's readonly/stale/no-op arm returns `[]` when
// disposed, and its accept / parse-failed arms post no Document); and the
// recovery arm, whose disposed branch emits only its toast + triage and never
// calls `ackEffects`. Deliberate in all four: there is no view left to resync,
// and the only loss worth reporting there (a dropped stash) has its own toast.
function withholdAckEffects(
  settled: HostSessionState,
  heldBase: number | null,
  context: HostSessionContext
): HostSessionEffect[] {
  return [
    // FIRST — and no longer because the executor leaves `logWarn` unguarded: it
    // does not (`effect-executor.ts`'s `case "logWarn"` contains the throw). The
    // order is DEFENCE IN DEPTH. That containment reports its own failure through
    // a SECOND console call, which can fail for the same reason the first did
    // (`reportContained`'s inert catch is the honest admission of this), so the
    // incident's only user-visible signal must not sit behind the log. The
    // reducer-side half holds even if the executor's per-effect guard is ever
    // removed. Same rule as the settlement's toast-before-reseed order, applied
    // to the withhold pair.
    { type: "showResyncFailure" },
    {
      type: "logWarn",
      message:
        "[quoll] settlement ack withheld: no post-apply document version was observed (every guarded version read for this settlement failed; no lock-held resync arrived) — posting would pair live bytes with a stale label",
      detail: {
        uri: context.uriString,
        heldBase,
        lastAppliedDocVersion: settled.lastAppliedDocVersion,
      },
    },
  ];
}

// The ack a settlement — or the write-lock recovery — posts: the authoritative
// Document when the label rests on a real observation, the withhold pair when it
// does not. ONE owner for that choice: all THREE ack sites call this (the
// per-outcome effects below, the drain's readonly/stale/no-op repost, and the
// `settlementTransitionFailed` arm), so no site can grow its own copy of the
// ternary and quietly diverge from the gate.
function ackEffects(
  ackLabelObserved: boolean,
  settled: HostSessionState,
  heldBase: number | null,
  context: HostSessionContext
): HostSessionEffect[] {
  return ackLabelObserved
    ? [postDoc(settled, settled.lastAppliedDocVersion)]
    : withholdAckEffects(settled, heldBase, context);
}

// A settlement's user-visible FAILURE toasts, and the ONE owner of their text.
// Split out because the disposed-no-stash arm wants exactly these and nothing
// else: asking `settlementEffects` for the full set and filtering it down to
// `showError` made that arm depend on the filter for its correctness, and
// forced it to hand the ack gate a fabricated `ackLabelObserved: true` for an
// ack it never wanted built. `ok` has no toast — a settlement that succeeded is
// not a failure, and an unverified landing is not a failed save.
function failureToasts(
  outcome: ApplyEditOutcome,
  context: HostSessionContext
): HostSessionEffect[] {
  switch (outcome.kind) {
    case "ok":
      return [];
    case "refused":
      return [
        {
          type: "showError",
          message: `Quoll could not save ${context.fsPath}. Reload the file or try again.`,
        },
      ];
    case "constructThrew":
    case "applyThrew":
    case "rejected":
      return [{ type: "showError", message: `Failed to save: ${outcome.message}` }];
    default: {
      const _exhaustive: never = outcome;
      throw new Error(
        `[quoll] unhandled ApplyEditOutcome: ${(_exhaustive as { kind: string }).kind}`
      );
    }
  }
}

// Per-outcome settlement effects: the ack Document (or its withhold pair, gated
// on `ackLabelObserved`) + non-ok diagnostics. Extracted so the applyEditSettled
// arm can SUPPRESS these wholesale when disposed (the webview is gone) and
// REPLACE them with drain effects when a stash drains.
//
// ORDER IS LOAD-BEARING on every non-ok arm: the failure `showError` comes
// BEFORE the ack `postDocument`. The two are independent surfaces — `showError`
// is a VS Code window toast, `postDocument` a webview-bound message — so there
// is no coupling to respect (the "Document before edit-rejected" constraint on
// `postRejectedDraft` is a different pair, both webview-bound and read by the
// same webview reducer). Toast-first is DEFENCE IN DEPTH, not the only guard:
// the reseed is the effect most likely to throw (`buildSeedDocument` bottoms out
// in `canonicalDocumentText(document)`), but the executor catches a builder
// throw and continues the effect loop, and its `showError` call is guarded too,
// so a later toast still reaches the user — `apply-edit-settle-rejection.test.ts`
// measures that CONTAINMENT and deliberately keeps no ordering assert of its own.
// The ORDER itself IS still pinned, in `host-session-core.test.ts`
// (`expectToastBeforeReseed`) — keep it there. The correlated failure is also
// narrower since `settle()` became total: a throwing `readCanonical` now
// resolves as an UNVERIFIED ok, and only the pipeline's synchronous prefix still
// produces `rejected`. Keep the order anyway — it costs nothing and removes the
// dependency on those guards. `ok` has no toast to order, so its single effect
// is unchanged.
function settlementEffects(
  outcome: ApplyEditOutcome,
  settled: HostSessionState,
  heldBase: number | null,
  context: HostSessionContext,
  ackLabelObserved: boolean
): HostSessionEffect[] {
  const ack = ackEffects(ackLabelObserved, settled, heldBase, context);
  switch (outcome.kind) {
    case "ok":
      return ack;
    case "refused":
      return [
        {
          type: "logWarn",
          message: "[quoll] applyEdit returned false",
          detail: { uri: context.uriString, baseDocVersion: heldBase },
        },
        ...failureToasts(outcome, context),
        ...ack,
      ];
    case "constructThrew":
    case "applyThrew":
    case "rejected":
      return [...failureToasts(outcome, context), ...ack];
    default: {
      const _exhaustive: never = outcome;
      throw new Error(
        `[quoll] unhandled ApplyEditOutcome: ${(_exhaustive as { kind: string }).kind}`
      );
    }
  }
}

export function createHostSessionCore(context: HostSessionContext, deps: HostSessionDeps = {}) {
  const validateForWrite = deps.validateForWrite ?? validateMarkdownForWrite;
  const mintEpochGeneration = deps.mintEpochGeneration ?? defaultMintEpochGeneration;

  function initialState(docVersion: number): HostSessionState {
    return {
      context,
      lastAppliedDocVersion: docVersion,
      pendingApplyBaseVersion: null,
      disposed: false,
      rejection: NONE,
      nextRejectionId: 1,
      pendingEdit: null,
      inFlightContent: null,
      externalEpoch: 0,
      epochGeneration: mintEpochGeneration(),
    };
  }

  function transition(state: HostSessionState, event: HostSessionEvent): HostSessionResult {
    // Post-dispose guard: every async settlement / stray listener is a no-op —
    // EXCEPT applyEditSettled, which must still be able to DRAIN a stashed
    // pending edit (the in-flight-apply + dispose data-loss race), and
    // settlementTransitionFailed, which must still DROP that stash and tell the
    // user (post-dispose the stash is the edit's only carrier — the webview's
    // retained replay buffer is gone with the iframe — and the `disposed` arm's
    // `effects: []` is what used to make the loss silent). With NO stash waiting
    // neither arm touches the stash or resyncs the webview; the HOST-side
    // signals are the exception — a failed settlement keeps its toast, and the
    // recovery keeps its internal-error toast plus triage, because after a close
    // a VS Code window toast is the only surface left.
    if (
      state.disposed &&
      event.type !== "disposed" &&
      event.type !== "applyEditSettled" &&
      event.type !== "settlementTransitionFailed"
    ) {
      return { state, effects: [] };
    }

    switch (event.type) {
      case "seed":
      case "ready": {
        if (state.pendingApplyBaseVersion !== null) {
          return {
            state,
            effects: [
              {
                type: "logWarn",
                message:
                  "[quoll] ready received during write lock; dropping seed (resync follows at post-apply docVersion)",
                detail: { pendingApplyBaseVersion: state.pendingApplyBaseVersion },
              },
            ],
          };
        }
        if (state.rejection.kind === "pending") {
          // Re-stamp a FRESH delivery id on the replayed rejection (Codex N6).
          // This replay is a NEW re-delivery ATTEMPT of A's banner carrying a
          // fresh delivery id, so the per-delivery identity holds at both ends:
          //   (a) an earlier `postEditRejected` attempt still in flight is now
          //       stale — its delayed delivery-failure (carrying the pre-replay
          //       id) no longer matches, so it is a no-op and cannot re-clear
          //       the banner this replay restored.
          //   (b) THIS attempt's own delivery is NOT assumed to succeed: the
          //       executor delivers `postRejectedDraft`'s banner failure-aware
          //       via `sendEditRejected(error, id)`, so if the replay banner
          //       delivery itself fails (webview detaches mid-reload) it
          //       re-enters as `editRejectedDeliveryFailed(id)` — matching THIS
          //       id — and clears the rejection + reseeds, recovering rather
          //       than leaving it stuck pending.
          // Without the re-stamp the replayed A reuses A's identity and (a)'s
          // stale failure would match in the `editRejectedDeliveryFailed` arm.
          const id = state.nextRejectionId;
          return {
            state: {
              ...state,
              rejection: { ...state.rejection, id },
              nextRejectionId: id + 1,
            },
            effects: [
              {
                type: "postRejectedDraft",
                content: state.rejection.content,
                error: state.rejection.error,
                docVersion: state.lastAppliedDocVersion,
                externalEpoch: state.externalEpoch,
                epochGeneration: state.epochGeneration,
                id,
              },
            ],
          };
        }
        // Resync to the LIVE snapshot before posting. The Document carries live
        // bytes (buildSeedDocument reads document.getText()); trusting the
        // possibly-stale stored version would pair new bytes with an old
        // version when an external edit is still coalescing in the
        // documentChanged debounce → stale-reseed keystroke loss. Mirrors the
        // `edit`/`documentChanged` arms' source-of-truth resync. `resyncLiveVersion`
        // also advances the epoch when the live version moved (this arm is only
        // reached lock-free — the lock guard returned above — so an advance is a
        // foreign external edit).
        const resynced = resyncLiveVersion(state, event.documentVersion);
        return {
          state: { ...resynced, rejection: NONE },
          effects: [postDoc(resynced, resynced.lastAppliedDocVersion)],
        };
      }

      case "edit": {
        // Source-of-truth resync FIRST (before the lock check), so stale
        // rejection is independent of onDidChangeTextDocument ordering.
        // Through `resyncLiveVersion` (not a hand-rolled raise) because this is
        // the KILLER epoch case: an external edit N→N+1 coalescing in the
        // debounce lands before the webview's Edit at base N, so the live
        // `documentVersion` here is N+1 > lastApplied N. Lock-free (no apply in
        // flight yet) ⇒ the helper increments the epoch, and the `stale`
        // verdict below posts a Document carrying the BUMPED epoch — without it
        // the resync would swallow the advance (the later debounced
        // `documentChanged` no-ops on the version-identical check) and finding
        // #4 recurs through the front door.
        const resynced = resyncLiveVersion(state, event.documentVersion);
        if (resynced.pendingApplyBaseVersion !== null) {
          // Host write lock held: STASH the latest edit intent instead of
          // dropping it. The webview only force-posts while in-flight on
          // teardown (its normal path buffers + replays on ack), so this is
          // the sub-ms close-race path. The stash drains through the full
          // decideEdit gates on settlement (alive AND post-dispose) — see the
          // applyEditSettled arm. Latest wins.
          return {
            state: {
              ...resynced,
              pendingEdit: { content: event.content, baseDocVersion: event.baseDocVersion },
            },
            effects: [
              {
                type: "logWarn",
                message:
                  "[quoll] inbound Edit during write lock; stashed for post-settlement drain",
                detail: {
                  baseDocVersion: event.baseDocVersion,
                  pendingApplyBaseVersion: resynced.pendingApplyBaseVersion,
                },
              },
            ],
          };
        }
        const verdict = decideEdit({
          baseDocVersion: event.baseDocVersion,
          lastAppliedDocVersion: resynced.lastAppliedDocVersion,
          canWrite: event.canWrite,
          content: event.content,
          currentContent: event.currentContent,
          markdownValidator: validateForWrite,
        });
        switch (verdict.kind) {
          case "readonly":
          case "stale":
          case "no-op":
            return {
              state: { ...resynced, rejection: NONE },
              effects: [postDoc(resynced, resynced.lastAppliedDocVersion)],
            };
          case "parse-failed": {
            const id = resynced.nextRejectionId;
            return {
              state: {
                ...resynced,
                rejection: { kind: "pending", id, content: event.content, error: verdict.error },
                nextRejectionId: id + 1,
              },
              effects: [
                { type: "postEditRejected", error: verdict.error, id },
                { type: "showError", message: `Cannot save: ${verdict.error.message}` },
              ],
            };
          }
          case "accept":
            // A newer edit supersedes a pending rejected draft, so clear the
            // rejection like every other inbound-edit arm and settlement path.
            // This also upholds the lock-held invariant structurally: the
            // `editRejectedDeliveryFailed` arm has no lock deferral (unlike
            // documentChanged / viewStateVisible), so a rejection surviving
            // into the lock would let a delayed delivery-failure post a
            // pre-apply-version Document mid-lock — an unsolicited reseed
            // that clears the webview's editInFlight and can transiently
            // wipe the accepted edit's content.
            return {
              state: {
                ...resynced,
                pendingApplyBaseVersion: event.baseDocVersion,
                inFlightContent: event.content,
                rejection: NONE,
              },
              effects: [
                { type: "applyEdit", content: event.content, baseDocVersion: event.baseDocVersion },
              ],
            };
          default: {
            const _exhaustive: never = verdict;
            throw new Error(
              `[quoll] unhandled EditVerdict: ${(_exhaustive as { kind: string }).kind}`
            );
          }
        }
      }

      case "applyEditSettled": {
        // Post-dispose with nothing to drain: stay a strict no-op (preserves the
        // disposed-settlement invariant) — EXCEPT a FAILED save still surfaces
        // its toast. `showError` survives dispose (a VS Code window toast, not
        // webview-bound) and after a close there is no editor left to retry, so
        // it matters more, not less. This covers BOTH a plain in-flight edit
        // failing post-dispose AND the DRAIN's own applyEdit failing — the
        // latter re-dispatches an `applyEditSettled` whose stash is already
        // drained (null), so it lands here; without this it would be a silent
        // data-loss (the stashed edit could not be saved and the user is never
        // told). A clean `ok` settle (incl. the applyEdit no-op on a GC'd
        // sole-editor document) has no showError, so no false alarm.
        if (state.disposed && state.pendingEdit === null) {
          // Toasts ONLY, built directly rather than filtered out of the full
          // settlement effects: this arm has no ack to gate, so it must not have
          // to name an ack-label observation it does not have. What it drops
          // along the way is the withhold pair — a logWarn plus
          // `showResyncFailure`, which the executor turns into a VS Code WINDOW
          // TOAST, not a webview-bound message (same distinction as the
          // `showError` note above). That suppression is for a DIFFERENT reason
          // than the ack's: post-dispose there is no view left to resync, so
          // telling the user it could not be resynced is noise. A dropped stash
          // is the one loss that still matters post-dispose, and it gets its own
          // toast below.
          return { state, effects: failureToasts(event.outcome, state.context) };
        }
        const heldBase = state.pendingApplyBaseVersion;
        const stash = state.pendingEdit;
        const inFlight = state.inFlightContent;
        const released: HostSessionState = {
          ...state,
          pendingApplyBaseVersion: null,
          rejection: NONE,
          pendingEdit: null,
          inFlightContent: null,
        };
        // Unified settle-time version advance — EVERY outcome kind, one source
        // (`event.settledVersion`), raised via Math.max so an observed version can
        // never REWIND the label (unlike the old ok-only verbatim assignment, this
        // is clamp-consistent with `resyncLiveVersion`; deliberately NOT routed
        // through that helper — the lock was just released above, so its lock-free
        // foreign-advance branch would double-count the epoch against site 2
        // below). NOT OBSERVED (`null`) ⇒ NO advance, no fabrication, no rewind.
        const advanced =
          event.settledVersion !== null
            ? Math.max(released.lastAppliedDocVersion, event.settledVersion)
            : released.lastAppliedDocVersion;
        const versioned: HostSessionState = { ...released, lastAppliedDocVersion: advanced };

        // Site 2 — settlement foreign-bytes check ⇒ epoch++, baseline per
        // outcome. OK: baseline is `inFlightContent` (the apply's target); a
        // mismatch means an external edit won the apply→settle race
        // (ok-but-mismatch). NON-OK: baseline is the canonical PRE-apply
        // snapshot — the failed apply left the document there, so equality means
        // nothing foreign intervened (the retry buffer stays replayable) and a
        // mismatch means a foreign edit raced the FAILED apply. Comparing a
        // non-ok settlement against `inFlightContent` would spuriously bump on
        // every transiently-failed save and drop the very keystrokes the
        // showError tells the user to retry. Lock-HELD `documentChanged`
        // resyncs deliberately did NOT increment (they may be this apply's own
        // echo); this is where that racy case is adjudicated.
        //
        // EOL-INSENSITIVE compare (contentMatches): `currentContent` /
        // `preApplyContent` are canonicalised to `document.eol` (readCanonical /
        // canonicalize), while `inFlightContent` is the raw webview bytes joined
        // with the CM `lineSeparator` facet — which is "\n" whenever the seed
        // carried no CRLF (an empty / single-line doc with eol=CRLF, e.g. every
        // new .md on Windows). A byte compare would then read a plain
        // newline-adding edit on such a doc as "foreign bytes" and bump the epoch
        // on the webview's OWN acked lineage. EOL mode is a canonicalisation
        // detail everywhere else in the pipeline, so the foreign-bytes verdict
        // must ignore it. The `a === b` fast path keeps the hot typing path
        // (byte-identical settle) regex-free — the normalise only runs when the
        // strings already differ (a genuine foreign edit, or this EOL skew).
        // Plan S6: an explicit `divergedAfterApply` annotation forces the
        // foreign-bytes verdict for the reducer path (finding #7). A genuine
        // divergence also trips the ok byte compare (settled !== inFlight), so
        // this disjunct is belt-and-braces — but it keeps the convergence driven
        // by the executor's authoritative verdict, not a re-derived heuristic.
        const divergedAfterApply = event.outcome.kind === "ok" && event.divergedAfterApply === true;
        // content unobserved ⇒ the verdict falls back to POSITIVE version-delta
        // evidence (below); treating MISSING evidence as foreign remains the
        // rejected variant.
        const observed = event.currentContent;
        // Content-unobserved fallback: POSITIVE version-delta evidence only. Our
        // own write contributes exactly one version increment on an ok apply and
        // zero otherwise. "+1 per content change" is de facto, NOT an API
        // contract — VS Code guarantees only that `TextDocument.version`
        // strictly increases per change; it holds for Quoll's write shape (a
        // single-replace WorkspaceEdit producing one content change event). If
        // it ever drifts, the failure direction is bounded and stated honestly:
        // a multi-increment OWN edit is misread as foreign → one spurious epoch
        // bump → the webview reseeds and its replay buffer is dropped (buffered-
        // keystroke loss, never corruption); a foreign edit batched into zero
        // extra increments is MISSED → no bump, which is exactly the
        // pre-existing accepted residual for an unobserved settlement. A delta
        // BEYOND our contribution proves something foreign also moved the
        // document. "No advance" is NOT evidence (`!ownEditOnly` would
        // re-import the rejected "missing ⇒ foreign" through the back door and
        // drop the replay buffer for a write that landed exactly as intended).
        // ⚠️ `ok` does NOT mean "+1" in every case: a real apply contributes one
        // increment, but the no-op short-circuit (execute-write.ts) settles
        // `applied` WITHOUT submitting an edit, so its contribution is 0. The
        // outcome kind cannot tell them apart, so this takes the LARGER of the
        // two — an over-stated allowance, which errs towards "not foreign" and
        // therefore towards keeping the replay buffer. That over-statement is
        // harmless rather than a missed foreign +1: the no-op path returns BEFORE
        // execute-write's only `await`, so the whole heldBase → settle-read window
        // is one synchronous tick on the single-threaded host and no external edit
        // can interleave to spend the extra allowance.
        const ownContribution = event.outcome.kind === "ok" ? 1 : 0;
        const foreignAtSettle =
          divergedAfterApply ||
          (observed !== null
            ? event.outcome.kind === "ok"
              ? inFlight !== null && !contentMatches(observed, inFlight)
              : !contentMatches(observed, event.preApplyContent)
            : heldBase !== null && versioned.lastAppliedDocVersion > heldBase + ownContribution);
        const settled: HostSessionState = foreignAtSettle
          ? { ...versioned, externalEpoch: versioned.externalEpoch + 1 }
          : versioned;

        // The ack-label gate. The ack Document pairs LIVE bytes (buildSeedDocument
        // reads the document at effect time) with the reducer's version label, so
        // the label must be backed by a real `document.version` OBSERVATION:
        //   - the settle-time/retry read succeeded (`settledVersion !== null`), or
        //   - the version advanced under the lock (a lock-held documentChanged /
        //     edit resync — the wiring snapshots the live version into those
        //     events, so the raised label IS an observation; withholding here
        //     would break the lock-held deferral contract and leave a quiet
        //     document with no repost ever).
        // Byte equality is deliberately NOT evidence: an undone foreign edit
        // leaves identical bytes at a HIGHER version, and acking that label lets
        // the webview base its next Edit on it → stale verdict → lock-free
        // forward advance → epoch bump → replay buffer dropped.
        // ACCEPTED RESIDUAL on the second disjunct: it proves the version was
        // OBSERVED, not that the observation is POST-APPLY. `resyncLiveVersion`
        // raises the label for whoever moved the document — `onDidChangeTextDocument`
        // carries no producer and the lock-held wiring snapshots only the version —
        // so when the CONTENT is also unobserved, "our own echo arrived" and "a
        // FOREIGN edit landed while our echo never did" are the SAME reducer state
        // (heldBase V, label V+1, ok, settledVersion null, currentContent null)
        // and no predicate can separate them. (With an OBSERVED content the
        // foreign reading shows up as a byte mismatch and `foreignAtSettle`
        // already bumps the epoch — that half is diagnosed, not residual.) In the
        // residual reading the ack pairs live bytes with a label one edit behind,
        // the same mislabel class the gate narrows elsewhere. It is not closable
        // HERE, and every narrowing considered also withholds the central case
        // (own echo, delta exactly 1), which is the receiving end of the
        // lock-held deferral contract — withhold it and a quiet document never
        // gets a repost at all. The failure stays bounded (stale verdict →
        // epoch bump → replay-buffer drop, no corruption), needs a triple
        // coincidence to reach, and is strictly better than the pre-gate
        // behaviour, which posted the STORED label unconditionally. The durable
        // fix is the liveness backstop tracked in the follow-up TODO entry.
        const ackLabelObserved =
          event.settledVersion !== null ||
          (heldBase !== null && settled.lastAppliedDocVersion > heldBase);

        // Drain is SAFE only when a stash is waiting, edit #1 applied cleanly
        // (`ok`), and the settled document is EXACTLY edit #1's result
        // (currentContent === inFlightContent). The last check keeps an
        // external edit that raced the apply→settle window from being
        // clobbered — the stash is dropped and the authoritative Document is
        // reposted (external wins, matching the pre-change drop). Non-ok never
        // drains (the save failed; its own showError surfaces it).
        // EOL-INSENSITIVE compare (contentMatches): identical to the epoch
        // verdict above — `currentContent` is canonicalised to `document.eol`
        // while `inFlightContent` is raw webview LF bytes, so a raw `===` would
        // misread a plain edit on a CRLF-eol single-line doc as "external won"
        // and DROP the stash instead of draining it (the webview's OWN acked
        // lineage, not a foreign edit).
        // CONTENT NOT OBSERVED ⇒ NO drain (the ack LABEL is a separate
        // question, taken up next). The drain's safety condition is an OBSERVED
        // equality — "the settled document IS edit #1's exact result" — which is
        // what keeps an external edit that won the apply→settle race from being
        // clobbered by the stash. Without the observation that condition cannot
        // be established, so the stash is dropped exactly as it is for a failed
        // save. While the panel is alive the keystroke still survives in the
        // webview's replay buffer (which this settlement deliberately does not
        // invalidate) — but "survives" is bounded, and the bound is the ACK:
        //   - with an ack Document, that Document is what replays it;
        //   - with the ack WITHHELD (unobserved label), nothing replays it here,
        //     and survival then depends on whether the epoch moves before an
        //     observed documentChanged/ready Document lands. The ORDINARY
        //     continuation is what can end it: this settlement releases the lock,
        //     so the apply's own echo reads as a lock-free forward advance, bumps
        //     `externalEpoch`, and the webview drops the buffer — the mechanism
        //     spelled out for the neighbouring REFUSAL case below, where it makes
        //     that refusal a deterministic loss. On a document whose version never
        //     advances again the epoch stays put and the buffer is still replayed
        //     (the quiet-document residual the follow-up TODO entry carries).
        // Post-dispose the stash is its only carrier, which is why the drop is
        // LOGGED below.
        // The ACK LABEL is deliberately NOT a conjunct below: the drain is a new
        // WRITE, not an ack, and its safety rests on the CONTENT evidence above.
        // ⛔ Do NOT re-add an `(ackLabelObserved || state.disposed)` conjunct here
        // (added in one review cycle and reverted after two independent advisors
        // traced the fault depth; `host-session-core.test.ts`'s "the drain
        // re-acquires the lock, so the label's catch-up is LOCK-HELD" goes red).
        // REFUSING at an unobserved label drops the keystroke, and the only
        // carrier left — the webview's replay buffer — is destroyed by the
        // ORDINARY continuation: the apply DID move the document, so its
        // `documentChanged` almost always arrives, and with the lock already
        // released it reads as a lock-free forward advance, bumps the epoch, and
        // `edit-sync.ts`'s `recordedEpoch > buf.epoch` drops the buffer. No
        // second fault is needed, so the refusal is a DETERMINISTIC loss.
        // DRAINING self-heals on that same continuation instead: the `accept` arm
        // re-acquires the lock at the settled base, so the late echo lands
        // LOCK-HELD (no bump) and its raise is itself the observation that
        // licenses the next ack.
        // ACCEPTED RESIDUAL — the stale re-base. Without an observation the
        // re-acquired base is a known-stale LOWER BOUND, so a later settlement's
        // version-delta fallback can read our own increment as foreign. Reaching
        // that needs a SECOND, independent read failure: the DRAINED apply's own
        // settlement must ALSO miss its CONTENT read (with the content observed,
        // `contentMatches` scores the increment correctly as ours) while
        // observing a version beyond `heldBase + ownContribution`. The cost is
        // then one spurious epoch bump — a replay-buffer drop, never corruption —
        // with the drained keystroke ALREADY on the document. Strictly shallower
        // harm at a strictly deeper fault. Tracked in the follow-up TODO entry —
        // but NOT closed by that entry's ack-timeout / reseed-retry half, which
        // only unsticks a quiet document that can no longer post: the mis-scoring
        // happens inside the NEXT settlement's version-delta fallback above,
        // which reads `heldBase` as EXACT and has no input a timeout or a retry
        // can reach. Closing it needs the entry's OTHER half — base provenance
        // (observed vs. lower bound), or an observed-version catch-up before the
        // re-base.
        const canDrain =
          stash !== null &&
          event.outcome.kind === "ok" &&
          inFlight !== null &&
          observed !== null &&
          contentMatches(observed, inFlight);

        if (!canDrain) {
          // Post-dispose the no-stash case already returned above, so a stash
          // is present here but undrainable (edit #1 failed, or an external
          // edit raced the apply→settle window). Suppress webview-bound effects
          // (the webview is gone) but KEEP a failed save's `showError`: after a
          // close there is no editor left to retry, so the toast matters more,
          // not less. A clean `ok` settle has no showError → []; a failure →
          // [showError]; an ok-but-mismatch (external won) is a valid
          // resolution, not a failure → also []. Alive: full effects.
          const baseEffects = settlementEffects(
            event.outcome,
            settled,
            heldBase,
            state.context,
            ackLabelObserved
          );
          // Diagnostic log for the post-apply divergence. THREE arms, in this
          // order — and the `null` semantics are written LITERALLY here so nobody
          // "fixes" a condition with `observed ?? ""`:
          //  1. `divergedAfterApply` (Plan S6) takes precedence and is emitted
          //     even with NO stash — a wrong-offset splice / lost external race
          //     must be visible for triage regardless of whether a keystroke was
          //     queued.
          //  2. An UNOBSERVED settlement holding a stash: `canDrain` refused for
          //     want of a CONTENT observation, so the keystroke is dropped.
          //     Post-dispose the stash was its only carrier, so the loss must be
          //     observable.
          //  3. The narrower ok-but-mismatch log (external edit won a stash's
          //     apply→settle race), which now REQUIRES an observation: claiming
          //     "external edit won the race" without having read the document
          //     would be a fabricated diagnosis, and an unobserved snapshot is not
          //     a mismatch.
          // None is a save failure, so none adds a showError (the ok baseEffects
          // carry none) — an unverified landing is not a failed save. Arm 2
          // POST-DISPOSE is the exception and gets its own toast below: there the
          // log is the whole signal and nobody is left to read it.
          //
          // There is deliberately no fourth arm for "the content matched but the
          // ack label was never observed": that configuration DRAINS (see
          // `canDrain`), so it never reaches this branch at all.
          const unobservedStashDrop =
            !divergedAfterApply &&
            stash !== null &&
            event.outcome.kind === "ok" &&
            observed === null;
          // Arms 2 and 3 share one guard — a stash present on an `ok`
          // settlement — stated ONCE below; only the observation splits them.
          let extraEffects: HostSessionEffect[] = [];
          if (divergedAfterApply) {
            extraEffects = [
              {
                type: "logWarn",
                message:
                  "[quoll] divergedAfterApply on settle: applyEdit landed content differs from intended (racing splice or external write); converging on authoritative content, epoch bumped",
                detail: {
                  stashBase: stash?.baseDocVersion ?? null,
                  settledDocVersion: settled.lastAppliedDocVersion,
                },
              },
            ];
          } else if (stash !== null && event.outcome.kind === "ok") {
            const detail = {
              stashBase: stash.baseDocVersion,
              settledDocVersion: settled.lastAppliedDocVersion,
            };
            if (observed === null) {
              // Arm 2 — the same predicate as `unobservedStashDrop` above (this
              // branch has already excluded `divergedAfterApply`), which is what
              // drives the post-dispose toast below.
              extraEffects = [
                {
                  type: "logWarn",
                  message:
                    "[quoll] unverified settle: pending stash dropped because the settled document could not be read",
                  detail,
                },
              ];
            } else if (!contentMatches(observed, inFlight)) {
              extraEffects = [
                {
                  type: "logWarn",
                  message:
                    "[quoll] ok-but-mismatch on settle: external edit won the race, pending stash dropped",
                  detail,
                },
              ];
            }
          }
          if (state.disposed) {
            return {
              state: settled,
              effects: [
                // POST-DISPOSE the stash was the dropped edit's ONLY carrier (no
                // webview, so no replay buffer to fall back on), so the loss must
                // stay USER-VISIBLE — not just logged. Before the settle-time
                // reads were guarded, this same physical event rejected the
                // pipeline and produced a `rejected` outcome, whose "Failed to
                // save" toast survived the dispose filter below; making the
                // settlement `ok` removed that toast and left the drop silent.
                // The wording must NOT re-introduce the false alarm the guarding
                // fixed: the write pipeline COMPLETED without failing, it is the
                // VERIFICATION that is missing, and what was dropped is the edit
                // stashed BEHIND it. Deliberately not "the apply landed" — the
                // no-op short-circuit (execute-write.ts) reaches this family
                // WITHOUT submitting an edit at all, so `appliedUnverified` is not
                // a landing claim and its ⚠️ note at `settle` binds caller text
                // too. The TOAST BODY below is unaffected and stays as written:
                // on the no-op route the document already holds the intended
                // bytes, and on the landed-but-unverified route the apply
                // resolved ok — which is why the toast pairs "saved your change"
                // with "could not verify it" and tells the user to reopen and
                // check. Do not drop that hedge: without the settle-time read a
                // misplaced splice (execute-write.ts's S5 escape) cannot be ruled
                // out.
                // ALIVE deliberately stays toast-free — there the webview's
                // single-flight replay buffer (which this settlement does not
                // invalidate) still holds the edit and re-posts it after the ack.
                ...(unobservedStashDrop
                  ? [
                      {
                        type: "showError" as const,
                        message: `Quoll saved your change to ${state.context.fsPath} but could not verify it before the editor closed, so a later unsaved edit was dropped. Reopen the file to check its contents.`,
                      },
                    ]
                  : []),
                ...extraEffects,
                ...baseEffects.filter((e) => e.type === "showError"),
              ],
            };
          }
          return {
            state: settled,
            effects: [...extraEffects, ...baseEffects],
          };
        }

        // Drain the stash through the FULL decideEdit gates, RE-BASED to the
        // settled version (safe: the document is edit #1's exact result, so the
        // stash — edit #1 + the extra keystroke — is a valid continuation).
        // base === lastApplied ⇒ `stale` never fires. The drain's effects
        // MIRROR the normal `edit` arm and REPLACE the ok ack Document.
        const verdict = decideEdit({
          baseDocVersion: settled.lastAppliedDocVersion,
          lastAppliedDocVersion: settled.lastAppliedDocVersion,
          canWrite: event.canWrite,
          content: stash.content,
          // `canDrain` already narrowed `observed` to `string` — the drain is
          // unreachable without an OBSERVED settled snapshot.
          currentContent: observed,
          markdownValidator: validateForWrite,
        });
        // The drain's own triage record for the STALE RE-BASE residual the
        // `canDrain` comment accepts. Every other degraded path in this file
        // logs; without this the one path that WRITES at a base it knows to be a
        // lower bound would be the exception, and a later spurious epoch bump
        // could not be attributed to the drain that caused it. NOT added to the
        // readonly/stale/no-op arm below — that arm already logs the same
        // incident through `withholdAckEffects`. NOT emitted post-dispose
        // either: there the `accept` arm deliberately does not re-acquire the
        // lock, so neither consequence named below can occur (no later
        // settlement reads this base, and no draft goes out).
        // Both exclusions live HERE, in the one place the record is built, so no
        // call site can carry half the gate: an arm that spreads it emits it
        // exactly when it is warranted.
        const staleReBaseWarn: HostSessionEffect[] =
          ackLabelObserved || state.disposed
            ? []
            : [
                {
                  type: "logWarn",
                  // Shared incident sentence, then the arm's own consequence —
                  // written as ONE owner for the shared half so the two arms
                  // cannot drift apart on what the incident WAS.
                  message:
                    "[quoll] unlabelled drain: the pending stash was re-based onto an UNOBSERVED settlement label (a known-stale lower bound). " +
                    (verdict.kind === "accept"
                      ? "The bytes land; the residual is that a later settlement which also misses its CONTENT read can score our own increment as foreign (one spurious epoch bump → replay-buffer drop)"
                      : "The stash did not validate, so no bytes land; the residual is that its rejected draft goes out stamped with this stale label"),
                  detail: {
                    uri: state.context.uriString,
                    heldBase,
                    lastAppliedDocVersion: settled.lastAppliedDocVersion,
                  },
                },
              ];
        switch (verdict.kind) {
          case "accept":
            // Re-acquire the lock + track the drained content as the new
            // in-flight — but NOT post-dispose (no more edits arrive; a
            // lingering lock would just sit in the discarded state).
            return {
              state: state.disposed
                ? settled
                : {
                    ...settled,
                    pendingApplyBaseVersion: settled.lastAppliedDocVersion,
                    inFlightContent: stash.content,
                  },
              effects: [
                ...staleReBaseWarn,
                {
                  type: "applyEdit",
                  content: stash.content,
                  baseDocVersion: settled.lastAppliedDocVersion,
                },
              ],
            };
          case "parse-failed": {
            const id = settled.nextRejectionId;
            return {
              state: {
                ...settled,
                rejection: { kind: "pending", id, content: stash.content, error: verdict.error },
                nextRejectionId: id + 1,
              },
              // showError survives dispose (VS Code toast). The banner post is
              // webview-bound — suppressed post-dispose (post() would drop it
              // anyway); when alive it REDELIVERS the draft as a Document at the
              // SETTLED version (postRejectedDraft), not a bare postEditRejected.
              // The drained-over apply already advanced lastAppliedDocVersion, so
              // a bare rejection would leave the webview on the pre-A version →
              // its next retry arrives stale → an authoritative reseed wipes the
              // draft (finding #2). The draft Document carries the SAME bytes the
              // editor already shows (never disk bytes — §6 holds; the live-path
              // parse-failed arm stays Document-free) while advancing the
              // webview's docVersion bookkeeping (so the next retry lands on a
              // live base instead of stale-rejecting). Mirrors the `ready`-arm
              // redelivery precedent.
              //
              // UNLIKE the readonly/stale/no-op repost BELOW (the next case in
              // this switch), this arm is DELIBERATELY NOT gated on
              // `ackLabelObserved` (round-2 reversal — see the plan's
              // dispositions table): in the unobserved-label corner (version
              // unread + no lock-held resync + the stash parse-failing) every
              // reviewed local variant, a Document-free degrade included,
              // converges to the same terminal state anyway — without an
              // observation no correct label-advance exists, and a `ready` replay
              // redelivers at the STORED label with no resync regardless. So this
              // draft CAN go out stamped with a stale label; that is an ACCEPTED
              // RESIDUAL, reachable because `canDrain` gates on CONTENT evidence
              // only (see its comment). A durable fix needs rejection-state
              // provenance + observed-version catch-up — its own slice, tracked in
              // the follow-up TODO entry.
              effects: state.disposed
                ? [{ type: "showError", message: `Cannot save: ${verdict.error.message}` }]
                : [
                    ...staleReBaseWarn,
                    {
                      type: "postRejectedDraft",
                      content: stash.content,
                      error: verdict.error,
                      docVersion: settled.lastAppliedDocVersion,
                      externalEpoch: settled.externalEpoch,
                      epochGeneration: settled.epochGeneration,
                      id,
                    },
                    { type: "showError", message: `Cannot save: ${verdict.error.message}` },
                  ],
            };
          }
          case "readonly":
          case "stale":
          case "no-op":
            // Nothing to write. Repost the authoritative (settled) Document so
            // the webview reseeds — suppressed post-dispose, and WITHHELD when
            // the label is unobserved (same gate as settlementEffects: this
            // repost is an ack Document too, and canDrain's observed CONTENT is
            // not version evidence). Both branches are LIVE: `canDrain` gates on
            // content, not on the label, so a drain that lands here at an
            // unobserved label takes the withhold arm. The shared `ackEffects` is
            // what keeps this site and `settlementEffects` from drifting apart.
            return {
              state: settled,
              effects: state.disposed
                ? []
                : ackEffects(ackLabelObserved, settled, heldBase, state.context),
            };
          default: {
            const _exhaustive: never = verdict;
            throw new Error(
              `[quoll] unhandled drain EditVerdict: ${(_exhaustive as { kind: string }).kind}`
            );
          }
        }
      }

      case "settlementTransitionFailed": {
        // THE SECOND LIVE WRITE-LOCK RELEASE SITE (the first is the settlement
        // itself; `disposed` also clears it, but only on teardown). It exists
        // because a throwing settlement TRANSITION leaves the lock held with no
        // second settlement coming — see the event member's comment.
        //
        // The arm is deliberately a PURE FIELD RESET plus effects: no
        // `decideEdit`, no outcome switch, no document read. Each of those is a
        // throw source of the transition being recovered from, and a recovery
        // that re-enters the seam that just threw can throw the recovery away
        // (docs/LEARNING.md 2026-08-09). That is ALSO why the stash is DROPPED
        // rather than re-run: `canDrain`'s safety condition ("the settled
        // document IS edit #1's exact result") needs an OBSERVED canonical
        // snapshot this arm must not go and read.
        const heldBase = state.pendingApplyBaseVersion;
        const stash = state.pendingEdit;
        // Resync BEFORE the release so that ON THE ALIVE PATH
        // `resyncLiveVersion`'s lock-free foreign-advance branch cannot fire:
        // an advance seen here is almost always the in-flight apply's OWN echo,
        // and bumping `externalEpoch` for it would make the webview drop the
        // replay buffer still holding the user's keystrokes. POST-DISPOSE the
        // `disposed` arm has already cleared the lock, so the branch DOES fire
        // and the epoch bumps — harmless there (the state is discarded and no
        // Document goes out), and pinned by a test so this note cannot drift.
        // `null` ⇒ no resync at all (no fabricated version).
        const resynced =
          event.settledVersion !== null ? resyncLiveVersion(state, event.settledVersion) : state;
        const recovered: HostSessionState = {
          ...resynced,
          pendingApplyBaseVersion: null,
          inFlightContent: null,
          pendingEdit: null,
          rejection: NONE,
        };
        // The settlement's own gate, computed the same way: our carried version
        // is an observation, OR a lock-held resync already raised the label
        // beyond the held base (that raise IS an observation — the wiring
        // snapshots the live version into those events).
        const ackLabelObserved =
          event.settledVersion !== null ||
          (heldBase !== null && recovered.lastAppliedDocVersion > heldBase);
        // UNCONDITIONAL, because the throwing transition ABANDONED its effect
        // list — and every non-ok outcome OWED a save-failure `showError` ahead
        // of its ack (`settlementEffects`' toast-before-reseed order; the
        // `refused` arm puts a triage `logWarn` first, so "owed before the ack"
        // is the true form, not "began the list"). This toast stands in for the
        // one that was owed. Outcome-BLIND wording: the arm never learns whether
        // the write landed, so it claims neither.
        //
        // The LOSS CLAUSE is the only conditional part, and its gate is "will
        // ANY ack Document go out to replay those bytes?" — NOT merely "are we
        // alive?". Alive WITH AN ACK the dropped stash is not a loss: the
        // webview still holds those bytes in the replay buffer `forcePost`
        // RETAINED under single-flight (`webview/cm/edit-sync.ts`), and the ack
        // below is the next ack that replays them — claiming a dropped edit
        // there would be a false alarm.
        //
        // The two branches with NO ack both report a loss, for different reasons
        // and — this is what the wording turns on — with different CERTAINTY:
        //   - POST-DISPOSE the retained buffer went with the iframe, so the
        //     stash was the edit's only carrier. CERTAIN.
        //   - ALIVE but `!ackLabelObserved`, the ack is WITHHELD
        //     (`withholdAckEffects` — no `postDocument` at all), and from there
        //     the bytes are lost in four steps, each in a different file:
        //     (1) no ack Document ⇒ the retained replay buffer is never
        //     replayed; (2) this arm sets `pendingApplyBaseVersion: null`, which
        //     makes the lock-free `foreignAdvance` branch of `resyncLiveVersion`
        //     reachable again; (3) the next `viewStateVisible` / `documentChanged`
        //     takes it and bumps `externalEpoch`; (4) the webview then satisfies
        //     `recordedEpoch > buf.epoch` and DROPS the buffer
        //     (`webview/cm/edit-sync.ts`). Spelled out link by link because a
        //     four-file chain is exactly the claim that goes stale silently.
        //     `showResyncFailure` does not cover it — that says the view could
        //     not be resynced, not that an edit was dropped.
        //     ⚠️ STEP (3) IS CONDITIONAL, and that is why the clause hedges
        //     rather than asserts: `resyncLiveVersion` bumps `externalEpoch` only
        //     on a lock-free FORWARD advance (`liveVersion >
        //     lastAppliedDocVersion`), so on a document whose version never moves
        //     again the epoch stays put, the next same-epoch Document REPLAYS the
        //     retained buffer (`edit-sync.ts`'s `shouldDropBufferedForEpoch`
        //     returns false for "same generation, epoch unchanged") and the bytes
        //     land after all. Outcome-blind, this arm cannot tell the two apart.
        // ⚠️ NOT the same gate as the settlement arm's `unobservedStashDrop`
        // toast, and the two are NOT reconciled by this change. That toast is
        // still emitted only inside the settlement arm's `if (state.disposed)`
        // branch, so in the structurally identical ALIVE state (ok, unobserved
        // content, unobserved version, stash present) the settlement arm emits NO
        // showError at all — measured. The divergence is deliberate for now:
        // widening that arm alone would hand the alive path a second toast that
        // contradicts `RESYNC_FAILURE_MESSAGE` on remedy, and its loss is
        // near-DETERMINISTIC there (the apply landed) rather than uncertain, so it
        // cannot reuse this wording either. Unifying the two behind one shared
        // predicate — with one incident yielding one remedy — is a follow-up
        // slice, stated here so the gap stays findable instead of silent.
        //
        // ACCEPTED RESIDUAL, stated here because this arm is where it is
        // created: the settlement's site-2 foreign-bytes check would have
        // bumped `externalEpoch` when an external edit raced the apply, and
        // this arm cannot — it is outcome-blind and must not read. So for a
        // non-ok settlement that BOTH raced a foreign edit and threw, the
        // same-epoch Document keeps the replay buffer alive and its replay can
        // land on top of the foreign bytes, inverting "external wins". Paying it
        // is worse either way: deciding needs a read through the seam that just
        // threw, and bumping unconditionally drops the replay buffer on EVERY
        // recovery — a deterministic loss on the common path to cover a
        // double-fault race that needs a type violation to reach at all. The
        // throw source is one of the two exhaustive-guard `default`s — the
        // `settlementEffects` switch, which is the one the ALIVE non-ok path
        // this residual describes actually reaches, or `failureToasts`' own on
        // the disposed-no-stash early return (where there is neither a stash nor
        // a replay buffer). The drain's two sources sit behind `canDrain`'s
        // content match, which by construction means no foreign edit raced.
        const lostStash = stash !== null && (state.disposed || !ackLabelObserved);
        // THREE branches, each ending in its own instruction rather than sharing
        // an appended one: a toast carrying three imperatives (copy, reload,
        // reopen) is a toast nobody follows.
        //   1. NO LOSS — just the closing instruction.
        //   2. POST-DISPOSE — DEFINITE. There is no webview, so the stash was the
        //      edit's only carrier and nothing can replay it. "Reopen" is the only
        //      available action; there is nothing left on screen to copy.
        //   3. ALIVE with a WITHHELD ack — HEDGED. This arm is outcome-blind, and
        //      one corner really does land the bytes (the never-advancing document
        //      above), so MAY is the strongest honest claim. "may not have been
        //      saved" is deliberately the SAME phrase `RESYNC_FAILURE_MESSAGE`
        //      uses, so if both toasts appear they cannot contradict each other on
        //      certainty; and the remedy composes with that toast's "reload the
        //      window" as an ORDER (copy, THEN reload) instead of a conflict. It
        //      must also stand alone: `showResyncFailure` is latched per panel, so
        //      the resync toast is NOT guaranteed to appear beside this one.
        //
        // ⚠️ Do NOT copy branch 3's hedge onto the settlement arm's
        // `unobservedStashDrop` toast. The two arms are alike in STATE and
        // OPPOSITE in the CERTAINTY of the loss: there the apply LANDED
        // (`outcome.kind === "ok"`), so its echo `documentChanged` arrives
        // lock-free, bumps `externalEpoch` and drops the replay buffer — the
        // near-DETERMINISTIC loss the settlement block's own "No second fault is
        // needed" note describes. A settlement-side message needs its own design,
        // not this wording.
        const lossClause = !lostStash
          ? " Reopen the file to check its contents."
          : state.disposed
            ? " A later unsaved edit was dropped. Reopen the file to check its contents."
            : " A later unsaved edit may not have been saved — copy any text you can still see in the editor before reloading the window.";
        const toast: HostSessionEffect = {
          type: "showError",
          message: `Quoll hit an internal error while completing a save of ${state.context.fsPath}.${lossClause}`,
        };
        // Triage LAST, as DEFENCE IN DEPTH rather than because the executor runs
        // `logWarn` unguarded — it contains the throw (`effect-executor.ts`'s
        // `case "logWarn"`). What that containment cannot promise is its own
        // report: it goes out through a second console call that can fail exactly
        // as the first did, so the ordering keeps the user-visible signal and the
        // un-park Document out from behind the log either way.
        // Detail key `recoveredVersion`, NOT `lastAppliedDocVersion`:
        // the invariant test greps that identifier's `:` form over
        // comment-stripped source, and a detail key of that name would read as a
        // hand-rolled version write and redden it.
        const triage: HostSessionEffect = {
          type: "logWarn",
          message:
            "[quoll] settlement transition threw; the write lock was force-released by the recovery arm" +
            (stash !== null ? " and the pending stash was DROPPED" : ""),
          detail: {
            uri: state.context.uriString,
            heldBase,
            stashBase: stash?.baseDocVersion ?? null,
            recoveredVersion: recovered.lastAppliedDocVersion,
          },
        };
        // The resync half is suppressed post-dispose (no view left to resync,
        // and the withhold pair's "could not resync" signal would be noise
        // there — same reasoning as the settlement's dispose arms). Alive it
        // goes through the SHARED `ackEffects`, so the ack-label gate keeps one
        // owner. Posting is what un-parks the webview's single flight.
        //
        // ONE list, so the toast-first / triage-last order the comments above
        // justify cannot be fixed on one branch and missed on the other: the
        // dispose difference is the ack half alone.
        const ack = state.disposed
          ? []
          : ackEffects(ackLabelObserved, recovered, heldBase, state.context);
        return { state: recovered, effects: [toast, ...ack, triage] };
      }
      case "editRejectedDeliveryFailed": {
        // Per-delivery identity (Codex N2/N6): only the delivery this failure
        // was issued for may be cleared. A stale failure whose id no longer
        // matches is a no-op. The id no longer matches when a newer rejection
        // B is pending or the rejection was cleared to `none` by a
        // resync/settlement (N2), OR when a `ready`/`seed` replay re-delivered
        // the SAME rejection A and re-stamped its delivery id (N6). In neither
        // case may the stale failure clobber the live banner nor force an
        // unsolicited reseed.
        if (state.rejection.kind !== "pending" || state.rejection.id !== event.id) {
          return { state, effects: [] };
        }
        if (event.documentVersion === null) {
          // UNOBSERVED recovery read (the executor's guarded readVersionGuarded
          // failed): same answer as the settlement ack gate — the recovery
          // reseed pairs LIVE bytes with the version label, so no observation ⇒
          // no Document. The rejection is still CLEARED (a stuck pending
          // rejection suppresses visible-edge resync — the deadlock this arm
          // exists to break); the user is signalled through the shared latch,
          // and the next OBSERVED Document (documentChanged / ready / edit
          // resync) converges.
          return {
            state: { ...state, rejection: NONE },
            // Same ordering rule as `withholdAckEffects` (this is an inline
            // copy of that pair): the user-visible signal precedes the triage
            // log, as defence in depth behind the executor's own per-effect
            // containment — see that helper for why the containment does not
            // make the order redundant.
            effects: [
              { type: "showResyncFailure" },
              {
                type: "logWarn",
                message:
                  "[quoll] edit-rejected recovery reseed withheld: the live document version could not be read; rejection cleared, awaiting an observed Document",
                detail: { uri: state.context.uriString, id: event.id },
              },
            ],
          };
        }
        // Resync to the live snapshot before the recovery reseed (see the
        // `ready` arm) — the reseed posts live bytes, so it must carry the
        // matching live version (and a bumped epoch if the live version moved:
        // this arm clears a rejection, which the `accept` arm proved cannot
        // survive into the write lock, so the resync is lock-free here).
        const resynced = resyncLiveVersion(state, event.documentVersion);
        return {
          state: { ...resynced, rejection: NONE },
          effects: [postDoc(resynced, resynced.lastAppliedDocVersion)],
        };
      }

      case "documentChanged": {
        // `workspace.onDidChangeTextDocument` also fires with empty
        // contentChanges and an UNCHANGED version on dirty-state transitions
        // (every save; near-continuous under autosave `afterDelay`). Such a
        // version-identical event carries no new bytes, so re-posting the
        // Document would destroy a pending rejected draft (the webview clears
        // the reject banner on a non-stale Document) and needlessly re-seed —
        // breaking the "preserves the user's typed bytes" invariant. No-op it:
        // the rejection is preserved and nothing is posted. Version-advancing
        // external edits fall through to the resync below.
        if (event.documentVersion === state.lastAppliedDocVersion) {
          return { state, effects: [] };
        }
        // Source-of-truth resync ALWAYS (lock held or not), mirroring the
        // `edit` arm's resync-first shape: the live document version is the
        // single source of truth even for a post we defer. `resyncLiveVersion`
        // increments the epoch ONLY on the lock-free branch (foreign external
        // edit); a lock-HELD advance here is usually the in-flight apply's own
        // echo, so the increment is withheld and site 2 adjudicates the racy
        // case at settlement.
        const resynced: HostSessionState = {
          ...resyncLiveVersion(state, event.documentVersion),
          rejection: NONE,
        };
        // While the host write lock is held, an accepted apply's own
        // `workspace.onDidChangeTextDocument` fires BEFORE the applyEdit
        // Promise settles. Posting here would emit a Document at the new
        // version while the lock is still held (Codex N1). Defer the post:
        // record the observed version and let the settlement repost the
        // authoritative version EXACTLY ONCE.
        // That repost is CONDITIONAL now — every settlement arm's ack is gated on
        // `ackLabelObserved`, and a draining stash replaces it with an applyEdit —
        // and the deferral stays safe because the raise recorded HERE is itself
        // the observation that licenses the ack: the wiring snapshots a real
        // `document.version` into this event, so a settlement that never manages
        // a read of its own still finds `lastAppliedDocVersion > heldBase` and
        // posts. Withholding on that disjunct would leave this deferred post with
        // no receiver at all.
        if (resynced.pendingApplyBaseVersion !== null) {
          return { state: resynced, effects: [] };
        }
        return { state: resynced, effects: [postDoc(resynced, resynced.lastAppliedDocVersion)] };
      }

      case "themeChanged":
        return { state, effects: [{ type: "postTheme", themeKind: event.themeKind }] };

      case "viewStateVisible": {
        if (state.pendingApplyBaseVersion !== null) {
          return { state, effects: [] };
        }
        if (state.rejection.kind === "pending") {
          return {
            state,
            effects: [
              {
                type: "logWarn",
                message: "[quoll] visible-edge resync suppressed: rejected draft pending",
                detail: { docVersion: state.lastAppliedDocVersion },
              },
            ],
          };
        }
        // Resync to the live snapshot before posting (see the `ready` arm) — the
        // reported bug's repro: focus the Quoll tab (viewStateVisible) while a
        // split-editor edit is still in the documentChanged debounce. Reached
        // only lock-free (the lock guard returned above), so an advance is a
        // foreign external edit and the epoch increments.
        const resynced = resyncLiveVersion(state, event.documentVersion);
        return {
          state: { ...resynced, rejection: NONE },
          effects: [postDoc(resynced, resynced.lastAppliedDocVersion)],
        };
      }

      case "openExternal":
        return { state, effects: [{ type: "openExternal", href: event.href }] };

      case "disposed":
        return { state: { ...state, disposed: true, pendingApplyBaseVersion: null }, effects: [] };

      default: {
        const _exhaustive: never = event;
        throw new Error(
          `[quoll] unhandled HostSessionEvent: ${(_exhaustive as { type: string }).type}`
        );
      }
    }
  }

  return { initialState, transition };
}

/** Queue-draining, non-recursive event dispatcher (Codex R2). `step(event)`
 *  runs one transition + its effects; an effect that synchronously
 *  re-dispatches enqueues behind the active loop and is drained AFTER
 *  `step` returns — flat, FIFO, never a recursive stack.
 *
 *  FAILURE POLICY — a throwing `step` does NOT cancel the rest of the drain.
 *  Scheduling is this primitive's ONLY job, so its contract is "every accepted
 *  event gets exactly one `step` ATTEMPT" — an attempt, not a success: this is
 *  scheduling, not transactional recovery. A sibling event's failure is not a
 *  reason to break it. The two rejected alternatives:
 *    - ABANDON the queue (today's shape: reset `draining`, keep the entries).
 *      The residue is not lost, it is DEFERRED — the next external dispatch
 *      drains it first, arbitrarily later, against a state it was never
 *      computed for. A stale replay is the worst of the three outcomes.
 *    - CLEAR the queue. Dropping accepted events is silent state loss, and for
 *      the host session it is unsafe by construction: `applyEditSettled` is
 *      the write lock's release site for a settlement that COMPLETES (the
 *      `settlementTransitionFailed` recovery arm releases it when a settlement
 *      transition THROWS, and this file's own `disposed` case clears it on
 *      teardown — see `isWriteLockHeld` above and `effect-executor.ts`'s
 *      header comment), so dropping an `applyEditSettled` strands the lock and
 *      the side channels deferred behind it for the rest of a still-alive
 *      session.
 *  Continuing leaves a WELL-FORMED state from either throw site inside `step`:
 *  a throwing TRANSITION leaves the committed state untouched, and a throwing
 *  EFFECT runs after the transition has already committed. See
 *  `host-session-step.ts`. What continuing does NOT do — and must not be read
 *  as doing — is REPAIR the failed event: the rest of that event's effect list
 *  stays abandoned. A throw from an `applyEditSettled` TRANSITION is not paid
 *  by any queue policy either — the state that would have released the lock was
 *  never committed. What pays it is the step's own recovery
 *  (`host-session-step.ts` commits `settlementTransitionFailed`, which releases
 *  the lock and disposes of the stash) together with the side-channel drop it
 *  performs alongside — see `HostSessionStepDeps.commitWriteLockRecovery`.
 *  Draining on is simply the least-bad of the three, not a rescue.
 *
 *  ⚠️ LIVENESS is unchanged and still the caller's to keep: a `step` that
 *  re-dispatches on every pass never empties the queue and this loop never
 *  returns — now also on the failure path, where the accumulated errors are
 *  never rethrown either. A bounded drain would trade that for the silent
 *  event loss this policy exists to avoid, so the bound stays where it always
 *  was: no effect may re-dispatch unconditionally.
 *
 *  Errors are neither swallowed nor allowed to displace each other: the drain
 *  finishes first, then a lone failure is rethrown AS-IS (callers keep the
 *  error identity and its triage payload) and several are rethrown together as
 *  an `AggregateError`. The throw still escapes to the caller, so the
 *  unhandled-rejection reasoning in `effect-executor.ts` is unchanged — only
 *  its timing moves to the end of the drain. */
export function createDrainingDispatcher<Ev>(step: (event: Ev) => void): (event: Ev) => void {
  const queue: Ev[] = [];
  let draining = false;
  return (event: Ev): void => {
    queue.push(event);
    if (draining) {
      // Already inside a drain — including a drain that is currently unwinding
      // a `step` throw, since the loop below catches per step and keeps going.
      return;
    }
    draining = true;
    const errors: unknown[] = [];
    try {
      while (queue.length > 0) {
        try {
          step(queue.shift() as Ev);
        } catch (err) {
          errors.push(err);
        }
      }
    } finally {
      // Released BEFORE the rethrow below, so a caller that dispatches from its
      // own catch handler starts a fresh drain rather than silently enqueueing
      // behind a loop that has already exited.
      draining = false;
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "[quoll] host session drain: multiple steps threw");
    }
  };
}
