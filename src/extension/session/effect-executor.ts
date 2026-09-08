// Host effect executor — turns the pure host-session reducer's EFFECTS into
// real side effects, and feeds async outcomes (applyEdit settlement,
// edit-rejected delivery failure) back into the core via the injected
// `dispatch`.
//
// Extracted verbatim from `resolveCustomTextEditor`'s closure so the
// dispose / lifecycle branches — previously reachable only through the e2e
// suite — get direct unit tests. Mirrors `edit-settled-barrier.ts` /
// `host-session-core.ts`: a deps-injected factory with ZERO runtime `vscode`
// import (type-only imports allowed). Every VS Code touch (WorkspaceEdit
// build, `workspace.applyEdit`, `document.getText/version`, theme/canWrite
// reads, `handleOpenExternal`) is injected via deps, so the module stays
// `vscode`-free and the message-content builders (already unit-covered in
// `document-message.test.ts`) are passed in as closures that read live
// theme/canWrite at CALL time (freshness contract preserved).
//
// ⚠️ Disposed-guard scope (do NOT over-apply). The `isDisposed()` guard belongs
// ONLY where the panel closure had it: `post`'s early-return + its `.then` OK
// arm (NOT the false/reject arms — those log unconditionally), and
// `sendEditRejected`'s early-return + BOTH `.then` arms. `runEffects` itself is
// NEVER wrapped in a disposed guard, and `runApplyEdit`'s `applyEditSettled`
// dispatch fires EVEN post-dispose in every arm (ok / refused / rejected, plus
// the pipeline-rejection arm) — the core is the decision authority and needs the
// settlement to drain a stashed last-keystroke edit (the
// "type-one-more-char-then-close" data-loss race). For the same reason BOTH
// promise arms of the settlement must reach `dispatch`: on the live path
// `applyEditSettled` is the only event that releases the host write lock (the
// core's `disposed` arm also clears `pendingApplyBaseVersion`, but that fires
// only on teardown, so it cannot rescue a panel the user is still typing into).

import type { MarkdownError } from "../../markdown/errors.js";
import { perfNow, perfRecord, perfReport } from "../../shared/perf.js";
import type { HostToWebview, ThemeKind } from "../../shared/protocol.js";
import type {
  DocumentWriteAdapter,
  DocumentWriteOutcome,
} from "../document-write/execute-write.js";
import { executeDocumentWrite } from "../document-write/execute-write.js";
import type {
  ApplyEditOutcome,
  HostSessionEffect,
  HostSessionEvent,
  HostSessionState,
} from "./host-session-core.js";

/** The VS Code build+apply+verify seam for the write executor (Plan S6). The
 *  pipeline itself lives in `document-write/execute-write.ts`; this alias keeps
 *  the panel's inline wiring + the executor deps stable. `TEdit` is the edit
 *  object the seam builds and applies. The executor never inspects one — it only
 *  forwards the seam to `executeDocumentWrite` — so the parameter is threaded
 *  (not erased to `unknown`) purely to keep the CALLER's build↔apply pair
 *  checked. Production infers it as `WorkspaceEdit` from the panel's literal. */
export type ApplyEditSeam<TEdit> = DocumentWriteAdapter<TEdit>;

export interface EffectExecutorDeps<TEdit> {
  isDisposed: () => boolean;
  /** Read for the `sendEditRejected` delivery-refused warn log
   *  (`lastAppliedDocVersion`) — the executor's only state read. The stash
   *  drain reads `pendingEdit` inside the core's `applyEditSettled` arm, not
   *  through here. */
  getState: () => HostSessionState;
  /** document.uri.toString() — for the sendEditRejected delivery-refused warn
   *  payload, kept byte-identical. */
  uriString: () => string;
  dispatch: (event: HostSessionEvent) => void;
  /** Harness-resolved postMessage surface (harness override ?? webview.postMessage). */
  send: (message: HostToWebview) => Thenable<boolean>;
  /** harness?.recordEvent ?? noop — called only on an accepted (ok=true) send. */
  recordEvent: (message: HostToWebview) => void;
  showError: (message: string) => void;
  canWrite: () => boolean;
  /** Live builders — read theme/canWrite/document text at call time (freshness).
   *  The (externalEpoch, epochGeneration) pair is core-managed and passed from
   *  the effect (self-contained, like docVersion). */
  buildSeedDocument: (
    docVersion: number,
    externalEpoch: number,
    epochGeneration: number
  ) => HostToWebview;
  buildRejectedDraft: (
    content: string,
    docVersion: number,
    externalEpoch: number,
    epochGeneration: number
  ) => HostToWebview;
  buildTheme: (themeKind: ThemeKind) => HostToWebview;
  buildEditRejected: (error: MarkdownError) => HostToWebview;
  applyEditSeam: ApplyEditSeam<TEdit>;
  /** Wraps handleOpenExternal(href, {openExternal, showError}). */
  openExternal: (href: string) => void;
}

export interface EffectExecutor {
  /** Side-channel outbound (also used internally). disposed guard + sync-throw
   *  guard + ok/false/reject arms + perf. */
  post: (message: HostToWebview) => void;
  /** Run each core EFFECT as a real side effect. */
  runEffects: (effects: readonly HostSessionEffect[]) => void;
}

export function createEffectExecutor<TEdit>(deps: EffectExecutorDeps<TEdit>): EffectExecutor {
  // Per-panel (per-createEffectExecutor-call) flag — NOT a module singleton.
  // A module-scope flag would suppress `host:mount` for every panel after the
  // first.
  let hostMountReported = false;

  // Per-panel latch for the reseed-build failure notification (see the
  // `postDocument` guard). One notification ATTEMPT per INCIDENT — a persistently
  // broken document seam can fire once per settlement, and a toast per settlement
  // is user-visible spam. The latch is RE-ARMED by a successful build (see the
  // `postDocument` case): a success proves the seam recovered, so the next failure
  // is a new incident and deserves its own signal. Without that, one transient
  // hiccup early in a panel's life would consume the session's only user-visible
  // signal for a state this module documents as one that must NOT be silent — and
  // panels live for hours.
  let reseedBuildFailureReported = false;

  // Alias for the injected open-external delegate (see the `openExternal` effect
  // case for why it is called via this local rather than `deps.openExternal(...)`).
  const runOpenExternal = deps.openExternal;

  // Host-side outbound. postMessage settles three ways:
  //   - resolves true  → VS Code runtime accepted/queued the message
  //                      (the only path that calls recordEvent).
  //   - resolves false → runtime cannot route right now: disposed,
  //                      hidden with retainContextWhenHidden=false,
  //                      or mid-reload. Normal route, not an edge
  //                      case. Logged at console.warn so production
  //                      triage can spot delivery gaps; intentionally
  //                      NOT recorded as a delivered event.
  //   - rejects        → host/webview transport detached. Logged at
  //                      console.error; also NOT recorded.
  // The webview-side outbound handler does not expose an equivalent
  // delivery signal, so the host log is the only place this gap is
  // observable.
  const post = (message: HostToWebview): void => {
    if (deps.isDisposed()) {
      return;
    }
    // A SYNCHRONOUS throw from send() escapes the `.then(...)` arms below:
    // the throw happens while EVALUATING `send(message)`, before the
    // Promise exists, so the reject arm never sees it. postMessage does not
    // throw synchronously in practice, but the harness seam / a future
    // transport could — and an unguarded throw here would unwind the
    // dispatch drain (and the VS Code event callback that drove this post).
    // Mirror runApplyEdit's sync-throw shape: catch + log, same triage
    // signal as the reject arm (Codex N5).
    let pending: Thenable<boolean>;
    const sendStart = QUOLL_PERF ? perfNow() : 0;
    try {
      pending = deps.send(message);
    } catch (err) {
      console.error("[quoll] host→webview postMessage threw synchronously", err, {
        type: message.type,
      });
      return;
    }
    if (QUOLL_PERF) {
      perfRecord("host:postMessage", perfNow() - sendStart);
    }
    void pending.then(
      (ok) => {
        if (ok) {
          if (deps.isDisposed()) {
            return;
          }
          deps.recordEvent(message);
          return;
        }
        console.warn("[quoll] host→webview postMessage resolved false", {
          type: message.type,
        });
      },
      (err: unknown) => {
        console.error("[quoll] host→webview postMessage rejected", err);
      }
    );
  };

  // Edit-rejected delivery with a resync fallback re-entering the core,
  // carrying the per-delivery `id` (Codex N2/N6). If the webview refuses,
  // detaches, or `send()` throws, dispatching `editRejectedDeliveryFailed(id)`
  // clears the rejection and reseeds a normal Document so the panel does not
  // deadlock — but ONLY when that `id` still matches the pending rejection.
  // A stale failure (a newer rejection B is pending, the rejection was already
  // cleared by a resync/settlement, or a `ready`/`seed` replay re-stamped the
  // id) is a no-op in the `editRejectedDeliveryFailed` arm, so it can neither
  // clobber the live banner nor force an unsolicited reseed. When the clear
  // DOES fire, the user's typed content is overwritten — same "external wins"
  // semantics as for an `onDidChangeTextDocument` race. The event carries the
  // LIVE document version (readVersion at this dispatch, read synchronously with
  // the reseed's live bytes) so the recovery Document's version matches its
  // bytes — never the possibly-stale stored version.
  const sendEditRejected = (error: MarkdownError, id: number): void => {
    if (deps.isDisposed()) {
      return;
    }
    const message = deps.buildEditRejected(error);
    // A SYNCHRONOUS throw from send() escapes the `.then(...)` arms below
    // (it happens before `Promise.resolve(...)` can assimilate it), so the
    // resync fallback would never run and the rejection would stay stuck
    // pending — the webview keeps a banner it can never resolve. Treat it
    // exactly like the reject arm: log + dispatch `editRejectedDeliveryFailed`
    // so the core clears the rejection and reseeds a Document (Codex N5).
    let pending: Thenable<boolean>;
    try {
      pending = deps.send(message);
    } catch (err) {
      console.error("[quoll] edit-rejected delivery threw synchronously; resync fallback", err);
      deps.dispatch({
        type: "editRejectedDeliveryFailed",
        id,
        documentVersion: deps.applyEditSeam.readVersion(),
      });
      return;
    }
    // Promise.resolve(...) assimilation: a non-standard Thenable can no
    // longer resolve SYNCHRONOUSLY and re-enter the active drain — the
    // `editRejectedDeliveryFailed` feedback always lands in a fresh drain,
    // so it can never be stranded behind a throwing `.then` mid-drain.
    void Promise.resolve(pending).then(
      (ok) => {
        if (deps.isDisposed()) {
          return;
        }
        if (ok) {
          deps.recordEvent(message);
          return;
        }
        console.warn("[quoll] edit-rejected delivery refused; resync fallback", {
          uri: deps.uriString(),
          docVersion: deps.getState().lastAppliedDocVersion,
        });
        deps.dispatch({
          type: "editRejectedDeliveryFailed",
          id,
          documentVersion: deps.applyEditSeam.readVersion(),
        });
      },
      (err: unknown) => {
        if (deps.isDisposed()) {
          return;
        }
        console.error("[quoll] edit-rejected delivery rejected; resync fallback", err);
        deps.dispatch({
          type: "editRejectedDeliveryFailed",
          id,
          documentVersion: deps.applyEditSeam.readVersion(),
        });
      }
    );
  };

  // Map a verified-write outcome (Plan S6 `document-write/`) to the reducer's
  // `ApplyEditOutcome`. 1:1 against today's five kinds; `diverged` is an `ok`
  // apply whose landed bytes differ from intended (racing splice / external
  // race) and rides out as `ok` + the `divergedAfterApply` annotation on the
  // event (NOT `refused` — the apply DID land; this is conflict resolution, not
  // a save failure).
  const toApplyEditOutcome = (result: DocumentWriteOutcome): ApplyEditOutcome => {
    switch (result.tag) {
      case "applied":
      case "diverged":
      // An UNVERIFIED outcome is still a NON-FAILURE: the write pipeline
      // completed (an apply resolved ok, or the no-op short-circuit submitted
      // nothing) and only the verification read failed. Mapping it to a failure
      // kind would toast "Failed to save" for a write that did not fail, and
      // skip the self-advance. `documentVersion` rides through as `null` when the
      // version was not observed — the reducer then leaves the version alone (no
      // fabrication, no rewind); when it WAS observed the normal self-advance
      // applies.
      case "appliedUnverified":
        return { kind: "ok", documentVersion: result.settledVersion };
      case "applyRefused":
        return { kind: "refused" };
      case "buildThrew":
        return { kind: "constructThrew", message: result.message ?? "" };
      case "applyThrew":
        return { kind: "applyThrew", message: result.message ?? "" };
      case "applyRejected":
        return { kind: "rejected", message: result.message ?? "" };
      default: {
        const _exhaustive: never = result.tag;
        throw new Error(`[quoll] unhandled DocumentWriteTag: ${String(_exhaustive)}`);
      }
    }
  };

  // Best-effort error → message for a settlement toast. Guarded because a
  // rejection value can be an exotic object whose `message` getter or `toString`
  // throws, and this runs while BUILDING the settlement event. An unguarded
  // throw here would abort that build, so `applyEditSettled` — the event that
  // releases the write lock — would never be dispatched: the very failure this
  // module's settlement guards exist to prevent. (It is evaluated inside the
  // rejection arm's `try`, so such a throw would be logged rather than escaping
  // as an unhandled rejection — but a log is not a released lock, which is why
  // the guard belongs HERE, at the source, and not on the catch.) This is NOT a
  // blanket "both arms are non-throwing" guarantee: `toApplyEditOutcome` and the
  // fulfilment arm's `deps.dispatch` are deliberately left unwrapped (swallowing
  // a reducer bug would hide it). The rejection arm's `dispatch` IS wrapped, but
  // only so a throwing settlement EFFECT is logged instead of becoming an
  // unhandled rejection — see that arm.
  const errorMessage = (err: unknown): string => {
    try {
      // `String(...)` wraps the WHOLE expression, not just the non-Error arm: an
      // `Error` whose `message` getter returns an object with a throwing
      // `toString` would otherwise escape UNCONVERTED and blow up later in
      // `settlementEffects`' `Failed to save: ${outcome.message}` template — from
      // inside the rejection arm whose entire job is to release the lock.
      return String(err instanceof Error ? err.message : err);
    } catch {
      return "unknown error";
    }
  };

  // `canWrite` is an FS/config read (not a document read) and is the principal
  // throw source in the settlement's fulfilment arm (`toApplyEditOutcome`'s
  // exhaustiveness guard also throws from the same object literal, but it is
  // unreachable for the closed tag union `execute-write.ts` produces). A throw
  // here escapes the `.then` (an `onRejected` sibling does NOT catch its own
  // `onFulfilled`) and strands the write lock forever, so read it defensively.
  // Assume NOT writable on a throw. That is a real trade-off, not a free win:
  // `canDrain` does NOT consult `canWrite`, so a false negative still runs the
  // drain, `decideEdit` then returns `readonly`, and the core's `readonly` arm
  // drops the stash WITHOUT a showError. While the panel is alive the keystroke
  // survives regardless — the webview's single-flight replay buffer
  // (`webview/cm/edit-sync.ts`) still holds it and re-posts after the reseed.
  // Post-dispose the stash is the only carrier and that keystroke is lost. That
  // loss is PRE-EXISTING and NOT introduced by this fallback — the identical
  // drop happens for a genuine read-only flip mid-flight, and it is strictly
  // better than the behaviour this arm replaced (an unguarded throw stranded the
  // lock, losing that keystroke AND every later edit for the session). Tracked
  // as its own TODO. The alternative here is worse: optimistically claiming
  // writability would let the reducer replay a write we could not confirm is
  // permitted.
  const readCanWrite = (): boolean => {
    try {
      return deps.canWrite();
    } catch (err) {
      console.error("[quoll] canWrite() threw at applyEdit settlement; assuming read-only", err);
      return false;
    }
  };

  // applyEdit executor — a THIN wrapper over the session-independent verified
  // write pipeline. The lock is already set by the `accept` transition; the
  // pipeline (snapshot → span → build → apply → post-apply verify) lives in
  // `executeDocumentWrite`, and this only MAPS the immutable tagged outcome onto
  // an `applyEditSettled` event. It NEVER re-reads the document — `currentContent`
  // / `preApplyContent` / the settled version all come from the outcome's
  // verify-time snapshots (a re-read could observe a later edit and mis-attribute
  // divergence). `canWrite` is read here (an FS/config read, not a document read)
  // for the stash-drain re-gate. The settlement lands in a fresh drain (the
  // pipeline is async) and fires EVEN post-dispose: a stashed one-more-char edit
  // can only drain on settlement, which fires AFTER onDidDispose (the core stays
  // a strict no-op post-dispose unless a stash is waiting; webview-bound posts
  // self-suppress via post()'s disposed guard).
  const runApplyEdit = (content: string): void => {
    void executeDocumentWrite(deps.applyEditSeam, content).then(
      (result) => {
        deps.dispatch({
          type: "applyEditSettled",
          outcome: toApplyEditOutcome(result),
          canWrite: readCanWrite(),
          currentContent: result.settledContent,
          preApplyContent: result.preApplyContent,
          divergedAfterApply: result.tag === "diverged",
        });
        // ⚠️ ORDER IS LOAD-BEARING — this warn sits AFTER `deps.dispatch`, and
        // must stay there. Anything evaluated on the way INTO the dispatch runs
        // before `applyEditSettled` fires, so a throw at that position skips the
        // dispatch and STRANDS THE WRITE LOCK for the session (the rejection arm
        // below cannot catch its sibling's throw; same reasoning as `readCanWrite`
        // there). Past the dispatch the panel has already committed the reduced
        // state and released the lock, so a throw here costs at most an unhandled
        // rejection.
        // Keyed on `settleReadFailure` rather than on the single
        // `appliedUnverified` tag, because a VERSION-only read failure keeps the
        // tag `applied` (the content was verified) while still suppressing the
        // self-advance — exactly the partial verification loss triage needs to
        // see, and tag-keyed logging would make it silent.
        //
        // Bounded to the ok-mapping family on purpose. A failure tag already
        // reports itself through its own message and its "Failed to save" toast;
        // adding a "the save completed" claim to the SAME settlement would put two
        // contradictory triage claims side by side for one event. The failure
        // family keeps a signal too, in NEUTRAL wording — the read failure is
        // worth seeing there as well, it just must not claim anything about how
        // the write itself was treated.
        if (result.settleReadFailure !== undefined) {
          const okFamily =
            result.tag === "applied" ||
            result.tag === "diverged" ||
            result.tag === "appliedUnverified";
          // The ok-family consequences are stated CONDITIONALLY because this
          // branch is keyed on `settleReadFailure`, not on the tag, so it also
          // covers the VERSION-only failure — where `readCanonical` succeeded,
          // the tag stays `applied`, `currentContent` IS observed, and the
          // reducer's `canDrain` can therefore pass. A flat "no stash drain"
          // would be false there.
          // "the write pipeline completed" rather than "applyEdit completed": the
          // no-op short-circuit reaches this family WITHOUT submitting an edit, so
          // caller warn text must not make a landing claim (execute-write.ts's
          // ⚠️ note at `settle`).
          // It must not deliver a VERDICT on the save either ("treating it as an
          // UNVERIFIED save" was the old wording): on the VERSION-only path the
          // CONTENT was read, the divergence compare ran and the tag stayed
          // `applied` — the save WAS verified, and only the self-advance is
          // suppressed. So name WHICH observation is missing and let each one gate
          // its own consequence. Naming the tag here would mislead symmetrically:
          // `diverged` is only reachable WITH an observed content, so "the tag is
          // now appliedUnverified" is false for part of this very family.
          console.warn(
            okFamily
              ? "[quoll] the write pipeline completed (no failure) but a settle-time verification read failed. Each missing observation gates only its OWN consequence: no drain unless the settled CONTENT was read (settledContent !== null), no version advance unless the VERSION was read (settledVersion !== null)"
              : `[quoll] the settlement verification read also failed on a ${result.tag} outcome; the outcome itself is unchanged`,
            result.settleReadFailure
          );
        }
      },
      // REJECTION ARM — the write lock's only release valve. `executeDocumentWrite`
      // now GUARDS its two settle-time verification reads individually, so those
      // can no longer reject the pipeline (a settle-read failure resolves as an
      // UNVERIFIED settlement instead). The ONE reachable rejection source is what
      // is left outside a try: the SYNCHRONOUS prefix (`readText` /
      // `canonicalize`, which run before anything can land, so a rejection there
      // really does describe a write that never happened).
      // ⚠️ This arm does NOT cover a throw from its own SIBLING — this is the
      // two-argument `.then(onFulfilled, onRejected)`, and `onRejected` never sees
      // `onFulfilled`'s throw (same limitation stated at `readCanWrite` above, and
      // the repo-wide "Update loop guard" invariant). That is exactly why the
      // fulfilment arm's throw sources are neutralised AT THE SOURCE instead — and
      // the consequence of an unguarded one differs by WHERE it sits:
      //   - BEFORE `deps.dispatch` (`readCanWrite`, evaluated while building the
      //     event object): the throw skips the dispatch entirely, so
      //     `applyEditSettled` never fires and the WRITE LOCK IS STRANDED.
      //   - INSIDE `runEffects` (the reseed's `buildSeedDocument`, the settlement
      //     `showError`): the panel commits the reduced state BEFORE running
      //     effects, so the lock is already released; a throw there costs an
      //     unhandled rejection plus the abandoned rest of the effect list. It no
      //     longer costs the barrier release: the panel's `step`
      //     (host-session-step.ts) settles UNCONDITIONALLY, with the verdict read
      //     from the event — see the `case "showError"` comment, which states the
      //     same thing.
      // Do not add an unguarded call in either place on the assumption that this
      // arm catches it. (`errorMessage` is guarded too, but it belongs to THIS
      // arm — its only call site is the dispatch below, inside this arm's own
      // `try` — not to the fulfilment one; see its definition.)
      // Without this arm the rejection is left UNHANDLED by `void`
      // (`void` does not catch — it only discards the promise reference),
      // `applyEditSettled` never fires, and `pendingApplyBaseVersion` — which ONLY
      // this event clears (host-session-core `applyEditSettled`; dispose is the
      // sole other path) — stays held for the session: every later inbound edit is
      // stashed behind a bare warn and never saved. Silent, toast-free data loss.
      // Settling with a NON-OK outcome is what makes it safe: `canDrain` requires
      // `ok`, so the unobserved snapshot below never reaches `decideEdit`, and the
      // non-ok foreign-bytes check reads a `null` `currentContent` as NOT OBSERVED
      // ⇒ not foreign, so no spurious epoch bump. The
      // user gets the same `Failed to save:` toast + authoritative reseed as any
      // other failed write, instead of a panel that has quietly stopped saving.
      //
      // ⚠️ This arm MUST NOT re-read the document or `canWrite()` — those seams are
      // the candidate throw sources, and a throw HERE strands the lock exactly as
      // before (the "fix" would reintroduce the bug on its own recovery path).
      // `canWrite` is unused for a non-ok settlement, so pass the conservative
      // `false` rather than reading it.
      (err: unknown) => {
        console.error("[quoll] verified write pipeline rejected; releasing the write lock", err);
        try {
          deps.dispatch({
            type: "applyEditSettled",
            outcome: { kind: "rejected", message: errorMessage(err) },
            canWrite: false,
            // NOT OBSERVED — nothing was read, so say nothing rather than
            // fabricating an empty document. The non-ok foreign-bytes check reads
            // `null` as "not foreign", exactly as the paired `""`/`""` used to by
            // accident of two equal empties; now it is the TYPED answer.
            currentContent: null,
            // INERT PLACEHOLDER, not a snapshot — and deliberately NOT the `null`
            // its sibling above became. Its single reader (host-session-core's
            // non-ok foreign-bytes compare) is inside the `currentContent !== null`
            // conjunct, which this settlement can never satisfy, so the value is
            // unreachable and widening the event field to `string | null` would buy
            // nothing but churn across the event type and its fakes. Documented at
            // the field, so a reader who moves outside that conjunct knows to make
            // it nullable first.
            preApplyContent: "",
          });
        } catch (dispatchErr) {
          // CORRELATED FAILURE — LAST LINE OF DEFENCE. `runEffects`'s
          // `postDocument` case now GUARDS its `buildSeedDocument` call (see
          // there), so the known correlated seam no longer unwinds `runEffects`:
          // it returns normally and the panel's post-effects
          // `editSettledBarrier.settle(...)` still runs. This catch remains for
          // any OTHER throwing effect on the rejection path. Two halves are
          // already safe without any rescue here: the write lock (the panel's
          // `step` commits the new state BEFORE running effects) and the
          // user-visible toast (`settlementEffects` emits `showError` BEFORE the
          // reseed for every non-ok outcome — see the ORDER note there; that is
          // why this catch does NOT re-raise a toast and cannot double-toast).
          // The barrier is safe too, whichever effect throws: the panel's `step`
          // (host-session-step.ts) settles UNCONDITIONALLY, so side-channel thunks
          // deferred behind it (handoff / switch-to-text) are DROPPED per the
          // failed-apply contract rather than surviving to run at the NEXT settle
          // against a document this edit never landed in. What a throw still costs
          // is the abandoned rest of the effect list plus an unhandled rejection.
          // Log only, and deliberately WITHOUT `deps.uriString()`: this catch is
          // the last line of defence, and that injected seam could throw too —
          // which would turn the log into an unhandled rejection. The cause's
          // stack is the triage payload.
          console.error("[quoll] applyEdit rejection settlement effects threw", dispatchErr);
        }
      }
    );
  };

  // Effect executor — turns each core EFFECT into the real side effect.
  // `postDocument` / `postRejectedDraft` stamp the wire docVersion from the
  // EFFECT (self-contained: the version a Document carries is a core
  // decision) and read only the live document text / theme / FS-writability
  // (those are not core state) via the injected builders.
  const runEffects = (effects: readonly HostSessionEffect[]): void => {
    for (const effect of effects) {
      switch (effect.type) {
        case "postDocument": {
          const buildStart = QUOLL_PERF ? perfNow() : 0;
          let documentMessage: HostToWebview;
          try {
            documentMessage = deps.buildSeedDocument(
              effect.docVersion,
              effect.externalEpoch,
              effect.epochGeneration
            );
          } catch (err) {
            // CORRELATED FAILURE, contained HERE rather than at the settlement's
            // `.then`. `buildSeedDocument` bottoms out in
            // `canonicalDocumentText(document)` — the same seam whose throw makes
            // a settlement UNVERIFIED — so the ack for an unverified landing is
            // the effect most likely to re-run a broken read. Unwinding
            // `runEffects` here would (a) escape the FULFILMENT arm as an
            // unhandled rejection, since `createDrainingDispatcher` has
            // `try/finally` and NO `catch`, and (b) abandon the rest of the effect
            // list. It would NOT skip the barrier release — the panel's `step`
            // settles unconditionally — but the ack Document is exactly the effect
            // worth keeping, so contain the throw here rather than relying on that
            // backstop. Only the injected BUILDER is guarded,
            // so a reducer bug still surfaces (the exhaustiveness guard below).
            //
            // ⚠️ The Document does NOT reach the webview either way — an escaping
            // throw would have skipped the `post()` just the same — and the
            // webview clears its single-flight `editInFlight` ONLY on a Document
            // or an `edit-rejected` (`webview/state.ts`). So until some later
            // Document arrives, its buffer holds the user's keystrokes and posts
            // nothing. What this fix must NOT do is make that state SILENT:
            // before it, the same scenario at least produced a (wrong) "Failed to
            // save" toast. Hence the one-shot signal below — the failure is
            // host-side and persistent-looking, and reloading the window is the
            // user's actual remedy. Latched to once per INCIDENT so a repeatedly
            // broken seam cannot storm the user, while a seam that recovers and
            // breaks again still gets a fresh signal (the re-arm below).
            console.error(
              "[quoll] failed to build the Document to post; skipping this reseed",
              err
            );
            if (!reseedBuildFailureReported) {
              // The latch is set BEFORE the attempt, so the guarantee is "at most
              // ONE notification attempt per incident" — not "exactly one toast".
              // ⛔ Do NOT move this to latch-after-success. Both placements lose
              // something and this is the safer loss:
              //   - latch-before: a single synchronous failure leaves only the log
              //     line above. Bounded, and by then the window API is broken.
              //   - latch-after-success: a `showError` that DISPLAYS and then
              //     throws is never latched, so a persistently broken seam
              //     re-toasts on every failed reseed — user-visible spam on a path
              //     that can fire once per settlement. `showError` evaluates
              //     `window.showErrorMessage(message)` BEFORE `showSafely` wraps
              //     it, and `showSafely` only absorbs the Thenable's async
              //     rejection, so display-then-throw cannot be ruled out from this
              //     repo alone.
              // Spam is the worse failure, and this placement removes it
              // structurally rather than by argument about VS Code internals.
              reseedBuildFailureReported = true;
              // GUARDED: this call sits INSIDE the boundary that exists to stop a
              // throw from escaping `runEffects`, and `window.showErrorMessage`'s
              // SYNCHRONOUS throw is not absorbed by the panel's wrapper — an
              // unguarded call here would re-open the exact hole this closes. Same
              // discipline as revert-rescue-wiring's per-dep `runGuarded`.
              try {
                // Wording that is true on BOTH paths this effect serves. The
                // reducer emits `postDocument` for the FIRST SEED too
                // (host-session-core's `ready` arm), not only for settlement acks,
                // and the executor cannot tell them apart — so an unconditional
                // "Recent edits may not be saved" would tell a user their edits
                // might be lost at first load, before they had typed anything.
                deps.showError(
                  "Quoll could not update the editor view. If you have unsaved changes they may not have been saved — reload the window (Developer: Reload Window)."
                );
              } catch (toastErr) {
                console.error("[quoll] failed to report the reseed build failure", toastErr);
              }
            }
            break;
          }
          if (QUOLL_PERF) {
            perfRecord("host:doc-build", perfNow() - buildStart);
          }
          // RE-ARM the notification latch: the build just succeeded, so the seam
          // recovered and any later failure is a NEW incident, not a repeat of the
          // one already reported. Orthogonal to the latch-before-attempt decision
          // above (which bounds a SINGLE incident); without this, one transient
          // early hiccup would leave every later real incident structurally
          // silent for the life of the panel.
          reseedBuildFailureReported = false;
          post(documentMessage);
          // First postDocument is the seed; report once it (and its
          // host:postMessage) is recorded so host:mount carries both stages.
          if (QUOLL_PERF && !hostMountReported) {
            hostMountReported = true;
            perfReport("host:mount");
          }
          break;
        }
        case "postRejectedDraft":
          // docVersion is the core-managed value (NOT a fresh
          // document.version read) — the rejected draft never ran
          // applyEdit, so the version is unchanged and the webview's next
          // Edit keeps a matching base. ORDER IS LOAD-BEARING: the webview
          // reducer's `document` arm clears `serializeError`, so the
          // Document MUST precede the `edit-rejected` (reversing it would
          // wipe the banner the user needs).
          post(
            deps.buildRejectedDraft(
              effect.content,
              effect.docVersion,
              effect.externalEpoch,
              effect.epochGeneration
            )
          );
          // The replay banner is FAILURE-AWARE: route it through
          // `sendEditRejected` (with the core-stamped fresh delivery id),
          // NOT a bare `post`. A `ready`/`seed` replay can fail to deliver
          // (the webview detaches mid-reload — a documented-normal `post`
          // outcome); a bare post would drop that failure silently and the
          // rejection would stay stuck pending forever (the re-stamp already
          // invalidated the pre-replay `postEditRejected` failure that used
          // to recover it, and visible-edge resync is suppressed while a
          // rejection is pending). Routing through `sendEditRejected`
          // dispatches `editRejectedDeliveryFailed(id)` on failure, so the
          // core clears the rejection and reseeds a Document — recovery
          // instead of a deadlock (Codex N6).
          sendEditRejected(effect.error, effect.id);
          break;
        case "postEditRejected":
          sendEditRejected(effect.error, effect.id);
          break;
        case "postTheme":
          post(deps.buildTheme(effect.themeKind));
          break;
        case "applyEdit":
          runApplyEdit(effect.content);
          break;
        case "showError":
          // GUARDED, and NOT redundant with the `deps.showError` guard inside the
          // `postDocument` builder catch above: that one protects the executor's
          // OWN reseed-build notification, this one the REDUCER's settlement toast,
          // which every non-ok settlement emits BEFORE its `postDocument` (see
          // `settlementEffects`' ORDER note). The containment matters here since
          // `settle()` became total: the correlated case — a failure tag whose
          // settle read ALSO threw — used to land in the rejection arm's
          // `try/catch`, and now resolves through the UNWRAPPED fulfilment arm.
          // `createDrainingDispatcher` has `try`/`finally` and no `catch`, so a
          // SYNCHRONOUS `window.showErrorMessage` throw would both escape as an
          // unhandled rejection and abandon the rest of this effect list —
          // including the ack `postDocument`. The barrier release survives either
          // way (the panel's `step` settles unconditionally), so this guard is
          // about the effect list, not the barrier. No latch: this is per-effect
          // containment, not notification suppression.
          try {
            deps.showError(effect.message);
          } catch (err) {
            console.error("[quoll] showError threw while running settlement effects", err);
          }
          break;
        case "logWarn":
          console.warn(effect.message, effect.detail);
          break;
        case "openExternal":
          // No additional logging here — isAllowedUrl rejection +
          // openExternal reject / sync-throw are all logged inside
          // handleOpenExternal.
          //
          // Called via the `runOpenExternal` alias (declared at the factory top)
          // so this delegation site does NOT textually match the
          // `env.openExternal(` choke-point guard (url-choke-point.test.ts).
          // This module only invokes the INJECTED closure (prod impl = the
          // panel's gated handleOpenExternal) and never the raw `env.openExternal`
          // binding, so it stays OUT of that guard's file allowlist — keeping the
          // guard able to flag a future raw binding call added here by mistake.
          runOpenExternal(effect.href);
          break;
        default: {
          // Exhaustiveness guard — a new HostSessionEffect variant without
          // a case here is flagged as `never` at compile time.
          const _exhaustive: never = effect;
          throw new Error(
            `[quoll] unhandled HostSessionEffect: ${(_exhaustive as { type: string }).type}`
          );
        }
      }
    }
  };

  return { post, runEffects };
}
