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
  | { readonly kind: "ok"; readonly documentVersion: number }
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
      // Fresh live snapshots taken by the wiring at settlement time so the
      // stash drain can re-run the FULL decideEdit gates (canWrite + canonical
      // current text). `currentContent` is the empty string when no stash is
      // waiting (the wiring skips the O(n) canonicalisation then — it is only
      // read when draining).
      readonly canWrite: boolean;
      readonly currentContent: string;
      // Canonical pre-apply document snapshot (the executor's `oldText`,
      // canonicalised). The settlement foreign-bytes check (site 2) uses it as
      // the baseline for a NON-OK outcome: a transiently failed save leaves the
      // document at the pre-apply content, so `currentContent === preApplyContent`
      // means nothing foreign intervened (the retry buffer must stay replayable);
      // a mismatch means a foreign edit raced the failed apply → epoch++. For an
      // OK outcome the baseline is `inFlightContent` instead, so this is unused
      // and the executor may pass the empty string (skipping its canonicalise on
      // the hot path).
      readonly preApplyContent: string;
    }
  | {
      readonly type: "editRejectedDeliveryFailed";
      readonly id: number;
      readonly documentVersion: number;
    }
  | { readonly type: "disposed" };

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
  | { readonly type: "openExternal"; readonly href: string };

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

/** Resync `lastAppliedDocVersion` to the live document version, raising it as
 *  `max(old, live)` so a late/reordered event or a future call site passing a
 *  LOWER version can never REWIND it (one clamp, one test). The `externalEpoch`
 *  increment is gated INTERNALLY: it fires only on a genuine LOCK-FREE forward
 *  advance (`liveVersion > old && pendingApplyBaseVersion === null`) — a
 *  lock-free advance is FOREIGN by construction (no self-apply is in flight, so
 *  the webview did not produce it), whereas a lock-HELD advance is usually the
 *  in-flight apply's own echo and is adjudicated by the settlement check
 *  instead. This is the SINGLE version-raising path in the reducer; the only
 *  other `lastAppliedDocVersion` write is the settlement `ok` self-advance (the
 *  sole documented exemption, fenced by the invariant test). */
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

// Per-outcome settlement effects: the ack Document (+ non-ok diagnostics).
// Extracted so the applyEditSettled arm can SUPPRESS these wholesale when
// disposed (the webview is gone) and REPLACE them with drain effects when a
// stash drains.
function settlementEffects(
  outcome: ApplyEditOutcome,
  settled: HostSessionState,
  heldBase: number | null,
  context: HostSessionContext
): HostSessionEffect[] {
  switch (outcome.kind) {
    case "ok":
      return [postDoc(settled, settled.lastAppliedDocVersion)];
    case "refused":
      return [
        postDoc(settled, settled.lastAppliedDocVersion),
        {
          type: "logWarn",
          message: "[quoll] applyEdit returned false",
          detail: { uri: context.uriString, baseDocVersion: heldBase },
        },
        {
          type: "showError",
          message: `Quoll could not save ${context.fsPath}. Reload the file or try again.`,
        },
      ];
    case "constructThrew":
    case "applyThrew":
    case "rejected":
      return [
        postDoc(settled, settled.lastAppliedDocVersion),
        { type: "showError", message: `Failed to save: ${outcome.message}` },
      ];
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
    // pending edit (the in-flight-apply + dispose data-loss race). Its arm
    // stays a strict no-op when no stash is waiting.
    if (state.disposed && event.type !== "disposed" && event.type !== "applyEditSettled") {
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
          const effects =
            event.outcome.kind === "ok"
              ? []
              : settlementEffects(
                  event.outcome,
                  state,
                  state.pendingApplyBaseVersion,
                  state.context
                ).filter((e) => e.type === "showError");
          return { state, effects };
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
        const versioned: HostSessionState =
          event.outcome.kind === "ok"
            ? { ...released, lastAppliedDocVersion: event.outcome.documentVersion }
            : released;

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
        const foreignAtSettle =
          event.outcome.kind === "ok"
            ? inFlight !== null && event.currentContent !== inFlight
            : event.currentContent !== event.preApplyContent;
        const settled: HostSessionState = foreignAtSettle
          ? { ...versioned, externalEpoch: versioned.externalEpoch + 1 }
          : versioned;

        // Drain is SAFE only when a stash is waiting, edit #1 applied cleanly
        // (`ok`), and the settled document is EXACTLY edit #1's result
        // (currentContent === inFlightContent). The last check keeps an
        // external edit that raced the apply→settle window from being
        // clobbered — the stash is dropped and the authoritative Document is
        // reposted (external wins, matching the pre-change drop). Non-ok never
        // drains (the save failed; its own showError surfaces it).
        const canDrain =
          stash !== null &&
          event.outcome.kind === "ok" &&
          inFlight !== null &&
          event.currentContent === inFlight;

        if (!canDrain) {
          // Post-dispose the no-stash case already returned above, so a stash
          // is present here but undrainable (edit #1 failed, or an external
          // edit raced the apply→settle window). Suppress webview-bound effects
          // (the webview is gone) but KEEP a failed save's `showError`: after a
          // close there is no editor left to retry, so the toast matters more,
          // not less. A clean `ok` settle has no showError → []; a failure →
          // [showError]; an ok-but-mismatch (external won) is a valid
          // resolution, not a failure → also []. Alive: full effects.
          const baseEffects = settlementEffects(event.outcome, settled, heldBase, state.context);
          const extraEffects: HostSessionEffect[] =
            stash !== null && event.outcome.kind === "ok" && event.currentContent !== inFlight
              ? [
                  {
                    type: "logWarn",
                    message:
                      "[quoll] ok-but-mismatch on settle: external edit won the race, pending stash dropped",
                    detail: {
                      stashBase: stash.baseDocVersion,
                      settledDocVersion: settled.lastAppliedDocVersion,
                    },
                  },
                ]
              : [];
          if (state.disposed) {
            return {
              state: settled,
              effects: [...extraEffects, ...baseEffects.filter((e) => e.type === "showError")],
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
          currentContent: event.currentContent,
          markdownValidator: validateForWrite,
        });
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
              effects: state.disposed
                ? [{ type: "showError", message: `Cannot save: ${verdict.error.message}` }]
                : [
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
            // the webview reseeds — suppressed post-dispose.
            return {
              state: settled,
              effects: state.disposed ? [] : [postDoc(settled, settled.lastAppliedDocVersion)],
            };
          default: {
            const _exhaustive: never = verdict;
            throw new Error(
              `[quoll] unhandled drain EditVerdict: ${(_exhaustive as { kind: string }).kind}`
            );
          }
        }
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
        // authoritative version EXACTLY ONCE (its `ok`/`refused`/throw arms
        // all postDocument from the released state).
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
 *  `step` returns — flat, FIFO, never a recursive stack. */
export function createDrainingDispatcher<Ev>(step: (event: Ev) => void): (event: Ev) => void {
  const queue: Ev[] = [];
  let draining = false;
  return (event: Ev): void => {
    queue.push(event);
    if (draining) {
      return;
    }
    draining = true;
    try {
      while (queue.length > 0) {
        step(queue.shift() as Ev);
      }
    } finally {
      draining = false;
    }
  };
}
