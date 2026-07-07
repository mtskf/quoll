// Top-level vanilla shell.
//
// Owns the reducer state, the single host-message subscription, and the
// editor mount. Theme is applied via class toggle on <html> so VS Code
// CSS variables reach every descendant; persisted metadata is written
// through the host wrapper, equality-guarded against the previous state.
//
// The shell does NOT parse content (C8): only the rawText
// (DocumentMessage.content) is seeded into the editor — the editor seam is
// text-canonical. The PM-bridge parse here used to drive parse-warning and
// parse-error banners, but under text-canonical no parse warning survives:
// raw HTML is preserved as inert source (proven by the C8 URL / raw-HTML /
// choke-point suites), and CodeMirror always seeds the raw bytes, so there is
// no "cannot display" state. The host write-gate (validateMarkdownForWrite) is
// the authoritative validation surface, and the host's `edit-rejected` →
// serializeError banner is the only surviving, HOST-sourced error surface —
// both untouched by this module. The webview also renders a second,
// shell-sourced banner — the self-clearing persistence-degraded notice — in
// the same banner area when `setMetadata` fails (see persistIfChanged below);
// it is driven by a shell-local flag, not reducer/host state.

import type { MarkdownErrorCode } from "../markdown/errors.js";
import { perfNow, perfRecord, perfReport } from "../shared/perf.js";
import { PROTOCOL_VERSION, type WebviewToHost } from "../shared/protocol.js";
import { renderBanners } from "./banners.js";
import { type EditorHandle, mountEditor } from "./editor.js";
import { getHost, subscribeToHost } from "./host.js";
import { type Action, initialState, reducer, type WebviewState } from "./state.js";

import "./styles.css";

// Tuple of every MarkdownErrorCode literal, used for two purposes:
//   1. `satisfies readonly MarkdownErrorCode[]` — compile-time guard that
//      each element is a valid member of the union.
//   2. `_AllLiteralsCovered` below — compile-time guard that no union member
//      is missing from this tuple.
// The tuple (not Set) is declared here so `satisfies` can see the element
// types; KNOWN_MARKDOWN_ERROR_CODES derives the runtime Set for O(1) lookup.
export const MARKDOWN_ERROR_CODE_LITERALS = [
  "unsafe_url",
  "invalid_frontmatter",
  "internal_error",
] as const satisfies readonly MarkdownErrorCode[];

type _AllLiteralsCovered =
  Exclude<MarkdownErrorCode, (typeof MARKDOWN_ERROR_CODE_LITERALS)[number]> extends never
    ? true
    : false;
const _allLiteralsCovered: _AllLiteralsCovered = true;
void _allLiteralsCovered; // suppress unused-variable lint

/** Closed-union mirror of `MarkdownErrorCode` (src/markdown/errors.ts) used
 *  at the host→webview wire boundary. The wire delivers `error.code` typed
 *  as plain `string` (the protocol layer cannot import bridge-internal
 *  types); this Set lets the shell narrow back to the closed union without
 *  trusting the wire to send a known literal. Derived from
 *  `MARKDOWN_ERROR_CODE_LITERALS` (see above for the exhaustiveness pin). */
export const KNOWN_MARKDOWN_ERROR_CODES: ReadonlySet<MarkdownErrorCode> = new Set(
  MARKDOWN_ERROR_CODE_LITERALS
);

/** Narrow a wire-delivered string to `MarkdownErrorCode`. Unknown codes
 *  (a future host shipping a literal this build does not know about, or
 *  a malformed message that slipped past the boundary validator's
 *  `typeof === "string"` check) fall back to `"internal_error"` so the
 *  banner still renders the host's `message` verbatim without violating
 *  the closed-union invariant the reducer relies on. */
export function narrowMarkdownErrorCode(code: string): MarkdownErrorCode {
  return (KNOWN_MARKDOWN_ERROR_CODES as ReadonlySet<string>).has(code)
    ? (code as MarkdownErrorCode)
    : "internal_error";
}

type PersistedFields = Pick<WebviewState, "ready" | "docVersion" | "canWrite" | "theme">;

function persistedFieldsEqual(a: PersistedFields, b: PersistedFields): boolean {
  return (
    a.ready === b.ready &&
    a.docVersion === b.docVersion &&
    a.canWrite === b.canWrite &&
    a.theme === b.theme
  );
}

export type ShellHandle = {
  /** Test-only teardown: unsubscribe from the host, destroy the editor,
   *  remove the inserted <main> from the container. Not invoked at
   *  runtime — a webview reload re-runs the entry. */
  dispose(): void;
};

export type ShellOptions = {
  nonce: string;
  /** Webview-resource base URI for relative image resolution; "" = no base. */
  resourceBaseUri?: string;
};

export function mountShell(root: HTMLElement, opts: ShellOptions): ShellHandle {
  const { nonce, resourceBaseUri = "" } = opts;
  // Skeleton DOM. The banner host sits above the editor mount; both live
  // inside one <main> so the existing styles.css selectors match.
  const main = document.createElement("main");
  const bannerHost = document.createElement("div");
  bannerHost.className = "quoll-banner-host";
  main.appendChild(bannerHost);
  // The editor mounts its own .quoll-editor div as a child of bannerHost's
  // sibling; we hand it `main` as the parent so it sits inside <main>.
  root.appendChild(main);

  let state: WebviewState = initialState;
  let persistenceDegraded = false;
  let editor: EditorHandle | null = null;
  const mountStart = QUOLL_PERF ? perfNow() : 0;
  let mountReported = false;
  let sessionReported = false;
  let shellDisposed = false;
  // Single-fire session report: pagehide AND dispose can both run when VS Code
  // destroys the webview, so latch to avoid a duplicate `[quoll][perf]` line.
  // The perfReport call is bare-`if (QUOLL_PERF)`-guarded INSIDE the function
  // (not just at the call sites) so the perfReport reference dead-codes even
  // through this indirection — without it esbuild can keep the closure and
  // leave perf-module residue in the bundle (Codex R3 #1).
  function reportSession(): void {
    if (sessionReported) {
      return;
    }
    sessionReported = true;
    if (QUOLL_PERF) {
      perfReport("webview:session");
    }
  }
  // Best-effort session report when VS Code tears the webview down (a reload
  // does NOT call shell.dispose). once:true + the latch above guard a double fire.
  const onPageHide = QUOLL_PERF ? (): void => reportSession() : null;
  if (onPageHide) {
    window.addEventListener("pagehide", onPageHide, { once: true });
  }
  // Local: a dispatch BEFORE the editor mount (e.g. a same-tick re-entry,
  // not currently possible but defensive) must not crash; editor is
  // assigned before the first message can arrive (subscribe is wired
  // synchronously after the editor mounts).

  function persistIfChanged(prev: WebviewState, next: WebviewState): void {
    if (!next.ready) {
      return;
    }
    const prevFields: PersistedFields = {
      ready: prev.ready,
      docVersion: prev.docVersion,
      canWrite: prev.canWrite,
      theme: prev.theme,
    };
    const nextFields: PersistedFields = {
      ready: next.ready,
      docVersion: next.docVersion,
      canWrite: next.canWrite,
      theme: next.theme,
    };
    if (persistedFieldsEqual(prevFields, nextFields)) {
      return;
    }
    try {
      getHost().setMetadata(nextFields);
      // A changed payload wrote successfully — clear a prior degraded episode.
      // Re-render directly (the banner is a pure function of reducer state ⊕
      // this shell-local flag); NO dispatch, so the single-drain re-entry
      // invariant and onReducerCommit are untouched.
      if (persistenceDegraded) {
        persistenceDegraded = false;
        renderBanners(bannerHost, next, persistenceDegraded);
      }
    } catch (err) {
      // First failure of an episode: log once + surface the banner. The latch
      // no longer skips-forever — subsequent throws while still degraded are
      // silent (no re-log, no re-render). Recovery is driven by the next
      // changed payload that writes successfully (the success arm above), so a
      // structural failure stays degraded while a transient one self-clears.
      if (!persistenceDegraded) {
        persistenceDegraded = true;
        console.error("[quoll] setMetadata failed; persistence degraded", err);
        renderBanners(bannerHost, next, persistenceDegraded);
      }
    }
  }

  function syncTheme(prev: WebviewState, next: WebviewState): void {
    if (prev.theme === next.theme) {
      return;
    }
    const html = document.documentElement;
    html.classList.toggle("dark-theme", next.theme === "dark");
    html.classList.toggle("light-theme", next.theme === "light");
  }

  // Initial class application from initialState. syncTheme below is a
  // prev/next diff, so without this one-shot apply, an initialState.theme
  // equal to the first Document's theme would silently leave the <html>
  // class blank (no transition → no toggle).
  {
    const html = document.documentElement;
    html.classList.toggle("dark-theme", state.theme === "dark");
    html.classList.toggle("light-theme", state.theme === "light");
  }

  function dispatch(action: Action): void {
    // Reducer is pure (state.ts) — a throw here is a precondition break,
    // not a defensive hole. The reducer test suite pins purity. If a
    // future Action variant introduces a throw, fix it in the reducer,
    // not by wrapping the dispatch.
    const dispatchStart = QUOLL_PERF ? perfNow() : 0;
    const prev = state;
    const next = reducer(prev, action);
    if (next === prev) {
      // No-op transition (a guard arm short-circuited). No render, no
      // drain, no persistence — the reducer is the spec.
      if (QUOLL_PERF) {
        perfRecord("webview:dispatch", perfNow() - dispatchStart);
      }
      return;
    }
    state = next;
    syncTheme(prev, next);
    renderBanners(bannerHost, next, persistenceDegraded);
    persistIfChanged(prev, next);
    // SINGLE drain entry, fired AFTER state + DOM update so canPost()
    // (inside edit-sync) reads the fresh reducer gate.
    //
    // SYNCHRONOUS RE-ENTRY: onReducerCommit may synchronously trigger
    // edit-sync's drain, which calls postEditMessage → dispatch("post-edit")
    // (or "serialize-error" on a host throw). The re-entry does NOT loop:
    // the reducer's post-edit action sets editInFlight=true, and the nested
    // onReducerCommit reads canPost()'s freshly-committed gate — its
    // replayIfNeeded early-returns on the in-flight flag. Upper bound: one
    // nested dispatch per outer ack/snapshot. Pinned by shell.test.ts's
    // "consent flip during in-flight Edit produces exactly one replay".
    editor?.onReducerCommit(next.editInFlight);
    if (QUOLL_PERF) {
      perfRecord("webview:dispatch", perfNow() - dispatchStart);
    }
  }

  // Mount editor FIRST so editor is non-null when the very first Document
  // arrives via the subscription below. The "ready handshake" invariant
  // is "subscribe before post(ready)", not "subscribe before everything".
  // Mounting first also keeps the design future-proof against a
  // subscribeToHost that ever gains synchronous cached delivery — the
  // `editor === null` branch in the document handler then becomes a
  // genuine defensive log instead of a real production path.
  editor = mountEditor({
    parent: main,
    nonce,
    resourceBaseUri,
    getState: () => state,
    dispatch,
  });

  const unsubscribe = subscribeToHost((message) => {
    // Routed via `switch` with a `default: never` exhaustiveness guard
    // (mirroring `QuollEditorPanel.handleInbound`) so a future
    // host→webview message type cannot silently fall through to the
    // `document` handler. `subscribeToHost` only delivers messages that
    // pass `isHostToWebview`, so the default arm is unreachable under the
    // protocol; it documents the closed-union invariant statically.
    switch (message.type) {
      case "theme":
        dispatch({ type: "theme", isDarkTheme: message.isDarkTheme });
        return;
      case "edit-rejected":
        // Host validated the inbound Edit and refused it. Mirror the
        // existing webview-side postMessage-failure path: set
        // serializeError, clear editInFlight via the reducer's
        // serialize-error arm. The editor's content is NOT touched — the
        // user's typed bytes survive the reject. The wire `error.code` is
        // plain `string` (the protocol layer cannot import
        // `MarkdownErrorCode`); narrow it back to the closed union here so
        // a future host shipping an unknown literal does not pollute the
        // reducer's invariant. Banners render `error.message` verbatim, so
        // the human-readable surface still carries the host's wording even
        // when `code` falls back to `internal_error`.
        dispatch({
          type: "serialize-error",
          error: {
            code: narrowMarkdownErrorCode(message.error.code),
            message: message.error.message,
          },
        });
        return;
      case "image-write-result":
        editor?.resolveImageWrite(message.requestId, message.ok ? message.relativePath : null);
        return;
      case "editor-config":
        editor?.setLintGutter(message.lintGutter);
        return;
      case "caret-apply":
        // One-shot caret handoff from the host (panel became active). Pure side
        // channel: it never enters the reducer (no docVersion / write-lock) — it
        // only moves the caret. Drop silently if the editor is not mounted.
        editor?.applyRemoteCaret({ line: message.line, character: message.character });
        return;
      case "document": {
        if (message.docVersion < state.docVersion) {
          // Stale — drop without touching the editor or the reducer (the
          // two-comparison rule, inlined at the call site).
          return;
        }
        if (editor === null) {
          // Defensive: mountEditor runs synchronously below before the
          // postMessage(ready), so this branch is unreachable in production.
          // Kept as a clear diagnostic if a future refactor reorders init.
          console.error("[quoll] Document received before Editor mounted — dropping", {
            docVersion: message.docVersion,
          });
          return;
        }
        const applyStart = QUOLL_PERF ? perfNow() : 0;
        editor.applyDocument(message.content, message.canWrite, message.docVersion);
        if (QUOLL_PERF) {
          const settled = perfNow();
          perfRecord("webview:doc-apply", settled - applyStart);
          if (!mountReported) {
            mountReported = true;
            perfRecord("webview:time-to-first-doc", settled - mountStart);
            // rAF so the first (synchronous) decoration build — triggered by
            // applyDocument's seed transaction → updateListener → orchestrator — is
            // recorded before the cold first-paint snapshot prints. shellDisposed
            // guards against firing after a fast close (the callback is async).
            requestAnimationFrame(() => {
              if (!shellDisposed) {
                perfReport("webview:mount");
              }
            });
          }
        }
        dispatch({
          type: "document",
          docVersion: message.docVersion,
          canWrite: message.canWrite,
          isDarkTheme: message.isDarkTheme,
        });
        return;
      }
      default: {
        // Exhaustiveness guard — when a new HostToWebview variant is added
        // without a case here, TS flags the assignment as `never` at
        // compile time. The isHostToWebview boundary validator already
        // rejects unknown wire types, so this arm is unreachable under the
        // protocol; it documents the closed-union invariant statically.
        const _exhaustive: never = message;
        throw new Error(
          `[quoll] unhandled HostToWebview: ${(_exhaustive as { type: string }).type}`
        );
      }
    }
  });

  // Teardown flush: a real tab close destroys the iframe WITHOUT calling
  // shell.dispose()/editor.dispose() (those are test-only), so the 300 ms
  // debounce buffer would die un-posted → silent data loss. Push the latest
  // bytes to the host on every teardown-precursor signal while the host is
  // still alive. flushPendingEdit() force-posts the latest bytes even while an
  // Edit is in flight (the host stashes + drains that in-flight arrival on
  // settlement; it keeps single-flight intact on an alive hide→show) and is a
  // no-op when nothing is pending, so these are cheap: visibilitychange:hidden fires when
  // the panel hides (incl. on close, retainContextWhenHidden keeps us alive to
  // deliver it, and on switch-away); pagehide on iframe teardown; blur when
  // focus leaves toward the close affordance. The listeners are REGISTERED
  // below — only AFTER the ready post succeeds — so an init failure (the catch
  // nulls editor + rethrows) never leaks a listener on the dead init-error
  // page; dispose() removes all three symmetrically.
  const flushPending = (): void => editor?.flushPendingEdit();
  const onVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      flushPending();
    }
  };

  try {
    const ready: WebviewToHost = { protocol: PROTOCOL_VERSION, type: "ready" };
    getHost().postMessage(ready);
  } catch (postErr) {
    // If the post throws, tear down the listener so it does not leak,
    // then propagate. The entry's top-level catch (index.ts) renders
    // the init-error banner.
    //
    // Wrap editor.dispose in try/ignore: a throw from view.destroy here
    // would mask postErr in the entry's catch (the user would see
    // "view.destroy failed" instead of the real "postMessage failed"
    // cause). The disposal is best-effort — the webview is about to be
    // torn down by VS Code anyway.
    unsubscribe();
    try {
      editor?.dispose();
    } catch (disposeErr) {
      console.error("[quoll] editor.dispose threw during init-failure cleanup", disposeErr);
    }
    editor = null;
    throw postErr;
  }

  // Register teardown-flush listeners now that init succeeded (see the const
  // declarations above for the rationale + the no-leak-on-init-failure note).
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", flushPending);
  window.addEventListener("blur", flushPending);

  return {
    dispose() {
      shellDisposed = true;
      if (onPageHide) {
        window.removeEventListener("pagehide", onPageHide);
      }
      if (QUOLL_PERF) {
        reportSession();
      }
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", flushPending);
      window.removeEventListener("blur", flushPending);
      unsubscribe();
      // try/finally so editor=null and main.remove() run even if
      // editor.dispose() throws. editor.ts's own dispose already wraps
      // view.destroy() in try/finally so mount.remove is safe; this outer
      // try/finally extends the same guarantee to main.remove on the
      // shell side, keeping init-success and init-failure cleanup paths
      // symmetric.
      try {
        editor?.dispose();
      } finally {
        editor = null;
        main.remove();
      }
    },
  };
}
