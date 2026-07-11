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
// dispatch fires EVEN post-dispose in every arm (ok / refused / rejected) — the
// core is the decision authority and needs the settlement to drain a stashed
// last-keystroke edit (the "type-one-more-char-then-close" data-loss race).

import type { MarkdownError } from "../../markdown/errors.js";
import { perfNow, perfRecord, perfReport } from "../../shared/perf.js";
import type { HostToWebview } from "../../shared/protocol.js";
import type { HostSessionEffect, HostSessionEvent, HostSessionState } from "./host-session-core.js";
import type { MinimalEditSpan } from "./minimal-edit.js";
import { minimalEditSpan } from "./minimal-edit.js";

/** VS Code WorkspaceEdit build+apply seam for runApplyEdit. `build` may throw
 *  (→ constructThrew); `apply` may throw synchronously (→ applyThrew) or settle
 *  async (→ ok/refused). The edit token is opaque to the module.
 *
 *  `readText` / `readVersion` / `readCanonical` are assumed non-throwing (as
 *  `document.getText()` / `document.version` / `canonicalDocumentText(document)`
 *  are today — they run OUTSIDE the build/apply try blocks). Only `build` throws
 *  map to `constructThrew`, only synchronous `apply` throws to `applyThrew`. */
export interface ApplyEditSeam {
  readText: () => string;
  readVersion: () => number;
  readCanonical: () => string;
  build: (span: MinimalEditSpan) => unknown;
  apply: (edit: unknown) => Thenable<boolean>;
}

export interface EffectExecutorDeps {
  isDisposed: () => boolean;
  /** drainSnapshot (pendingEdit) + sendEditRejected warn log (lastAppliedDocVersion). */
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
  /** Live builders — read theme/canWrite/document text at call time (freshness). */
  buildSeedDocument: (docVersion: number) => HostToWebview;
  buildRejectedDraft: (content: string, docVersion: number) => HostToWebview;
  buildTheme: (isDarkTheme: boolean) => HostToWebview;
  buildEditRejected: (error: MarkdownError) => HostToWebview;
  applyEditSeam: ApplyEditSeam;
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

export function createEffectExecutor(deps: EffectExecutorDeps): EffectExecutor {
  // Per-panel (per-createEffectExecutor-call) flag — NOT a module singleton.
  // A module-scope flag would suppress `host:mount` for every panel after the
  // first.
  let hostMountReported = false;

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
  // semantics as for an `onDidChangeTextDocument` race.
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
      deps.dispatch({ type: "editRejectedDeliveryFailed", id });
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
        deps.dispatch({ type: "editRejectedDeliveryFailed", id });
      },
      (err: unknown) => {
        if (deps.isDisposed()) {
          return;
        }
        console.error("[quoll] edit-rejected delivery rejected; resync fallback", err);
        deps.dispatch({ type: "editRejectedDeliveryFailed", id });
      }
    );
  };

  // applyEdit executor — the lock is already set by the `accept`
  // transition; this only constructs the WorkspaceEdit, applies it, and
  // reports every outcome back via `applyEditSettled`. The construct /
  // apply SYNC-throw paths dispatch-then-`return` cleanly (the enqueued
  // outcome is drained by the same loop, clearing the optimistic lock);
  // the async settlement is funnelled through `Promise.resolve(...).then`
  // so it lands in a fresh drain.
  const runApplyEdit = (content: string): void => {
    // OLD text = the live buffer (applyEdit has not run yet, and the write
    // lock — set by the accept transition — blocks any other inbound edit on
    // the synchronous dispatch chain). Diff against the inbound NEW content to
    // the smallest single span. Resulting buffer is byte-identical to a
    // whole-document replace (measured ~90ms@1MB whole-doc vs flat ~0.5ms
    // minimal; see PERF.md § Write-path applyEdit baseline).
    const oldText = deps.applyEditSeam.readText();
    // Snapshot the drain inputs the core needs at settlement. currentContent is
    // only consulted when a stash is waiting, so skip the O(n) canonicalisation
    // otherwise (Codex #6). Reads state via deps.getState(), as sendEditRejected
    // already does. LAZY: the thunk re-reads getState().pendingEdit at each
    // dispatch site (settlement time), never cached at apply-start — a stash
    // that appears during the in-flight apply must be observed at settle time.
    const drainSnapshot = () => ({
      canWrite: deps.canWrite(),
      currentContent:
        deps.getState().pendingEdit !== null ? deps.applyEditSeam.readCanonical() : "",
    });
    const span = minimalEditSpan(oldText, content);
    if (span.from === span.to && span.insert.length === 0) {
      // No-op short-circuit (defensive — the core already gates no-ops via the
      // canonical currentContent compare; only a mixed-EOL literal-buffer
      // match could reach here). Settle ok with the UNCHANGED version so the
      // write lock releases + resync proceeds, WITHOUT submitting an empty
      // WorkspaceEdit.
      deps.dispatch({
        type: "applyEditSettled",
        outcome: { kind: "ok", documentVersion: deps.applyEditSeam.readVersion() },
        ...drainSnapshot(),
      });
      return;
    }
    let edit: unknown;
    try {
      // positionAt clamps out-of-range offsets (never throws) and
      // minimalEditSpan is pure — so constructThrew stays unreachable in
      // practice; the arm is preserved for parity with the prior path.
      edit = deps.applyEditSeam.build(span);
    } catch (err) {
      deps.dispatch({
        type: "applyEditSettled",
        outcome: {
          kind: "constructThrew",
          message: err instanceof Error ? err.message : String(err),
        },
        ...drainSnapshot(),
      });
      return;
    }
    let pending: Thenable<boolean>;
    const applyStart = QUOLL_PERF ? perfNow() : 0;
    try {
      pending = deps.applyEditSeam.apply(edit);
    } catch (err) {
      // Synchronous apply throw: immediate failure, not a latency sample —
      // intentionally not recorded under host:applyEdit.
      deps.dispatch({
        type: "applyEditSettled",
        outcome: {
          kind: "applyThrew",
          message: err instanceof Error ? err.message : String(err),
        },
        ...drainSnapshot(),
      });
      return;
    }
    Promise.resolve(pending).then(
      (ok) => {
        if (QUOLL_PERF) {
          perfRecord("host:applyEdit", perfNow() - applyStart);
        }
        // Dispatch EVEN post-dispose: a stashed pending edit (typed
        // one-more-char then closed within the same ms while this apply held
        // the lock) can only drain on settlement, which fires AFTER
        // onDidDispose. The core stays a strict no-op post-dispose unless a
        // stash is waiting (host-session-core applyEditSettled). Webview-bound
        // posts self-suppress via post()'s disposed guard.
        deps.dispatch({
          type: "applyEditSettled",
          outcome: ok
            ? { kind: "ok", documentVersion: deps.applyEditSeam.readVersion() }
            : { kind: "refused" },
          ...drainSnapshot(),
        });
      },
      (err: unknown) => {
        if (QUOLL_PERF) {
          perfRecord("host:applyEdit", perfNow() - applyStart);
        }
        deps.dispatch({
          type: "applyEditSettled",
          outcome: {
            kind: "rejected",
            message: err instanceof Error ? err.message : String(err),
          },
          ...drainSnapshot(),
        });
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
          const documentMessage = deps.buildSeedDocument(effect.docVersion);
          if (QUOLL_PERF) {
            perfRecord("host:doc-build", perfNow() - buildStart);
          }
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
          post(deps.buildRejectedDraft(effect.content, effect.docVersion));
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
          post(deps.buildTheme(effect.isDarkTheme));
          break;
        case "applyEdit":
          runApplyEdit(effect.content);
          break;
        case "showError":
          deps.showError(effect.message);
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
