// Top-level vanilla shell.
//
// Owns the reducer state, the single host-message subscription, and the
// editor mount. Theme is applied via class toggle on <html> so VS Code
// CSS variables reach every descendant.
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
// both untouched by this module.

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

/** Register the post-init teardown listeners and return their remover.
 *
 *  Extracted as a named seam for two reasons:
 *   1. It collapses the add-list and the remove-list into ONE source of truth,
 *      so the "registered here but forgotten in dispose()" asymmetry — the very
 *      leak class this module guards against — cannot recur.
 *   2. The perf `onPageHide` listener is compiled out under `QUOLL_PERF=false`
 *      (every unit / browser / production build), leaving it with no observable
 *      surface in tests. Passing it as an argument lets a unit test drive the
 *      non-null branch directly and pin that onPageHide rides this after-init
 *      teardown set (rather than a mount-time registration) — the property the
 *      leak fix depends on.
 *
 *  `onPageHide` is registered before `flushPending`'s pagehide listener to
 *  preserve the original fire order (perf session report, then flush).
 */
export function attachTeardownListeners(handlers: {
  onPageHide: (() => void) | null;
  flushPending: () => void;
  onVisibilityChange: () => void;
}): () => void {
  const { onPageHide, flushPending, onVisibilityChange } = handlers;
  if (onPageHide) {
    window.addEventListener("pagehide", onPageHide, { once: true });
  }
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", flushPending);
  window.addEventListener("blur", flushPending);
  return () => {
    if (onPageHide) {
      window.removeEventListener("pagehide", onPageHide);
    }
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", flushPending);
    window.removeEventListener("blur", flushPending);
  };
}

export function mountShell(root: HTMLElement, opts: ShellOptions): ShellHandle {
  const { nonce, resourceBaseUri = "" } = opts;
  // Skeleton DOM. The banner host sits above the editor mount; both live
  // inside one <main> so the existing styles.css selectors match.
  const main = document.createElement("main");
  const bannerHost = document.createElement("div");
  bannerHost.className = "quoll-banner-host";
  main.appendChild(bannerHost);

  // ONE notice slot shared by the two edit-sync lifecycle signals — the S3b
  // clustering tripwire (onResyncStorm) and discarded un-acked local bytes from
  // EITHER holder, the pre-ack replay buffer or an Edit still awaiting its ack
  // (onLocalEditDiscarded). It lives OUTSIDE bannerHost so the reducer-driven
  // renderBanners (replaceChildren) never clobbers it, and it is NOT reducer
  // state — neither signal is a document error.
  //
  // The CONTAINER is created here, at mount, and is never removed — only
  // emptied. A live region inserted at the same moment as its text is not
  // reliably announced (W3C ARIA22), which is the flaw the previous
  // one-element-per-notice shape carried. Same technique as the outline panel's
  // announcer, but visible rather than visually hidden.
  const noticeHost = document.createElement("div");
  noticeHost.className = "quoll-notice-host";
  noticeHost.setAttribute("role", "status");
  noticeHost.setAttribute("aria-atomic", "true");
  main.appendChild(noticeHost);

  // The editor mounts its own .quoll-editor div as a child of bannerHost's
  // sibling; we hand it `main` as the parent so it sits inside <main>.
  root.appendChild(main);

  let state: WebviewState = initialState;
  let editor: EditorHandle | null = null;
  const mountStart = QUOLL_PERF ? perfNow() : 0;
  let mountReported = false;
  let sessionReported = false;
  let shellDisposed = false;

  // Notice slot behaviour. Declared AFTER `shellDisposed` because the deferred
  // storm render reads it.
  //
  // Two classes, TWO texts, deliberately not merged into one sentence: a storm
  // can fire with no input and no discard at all (pinned in shell.test.ts), so a
  // shared wording would either soften a near-certain loss to "may", or assert a
  // loss the storm case cannot prove. (Narrowed by the one-subject drain
  // judgement in cm/edit-sync.ts: a superseded holder whose bytes the
  // authoritative document carries VERBATIM (line endings aside) — the
  // byte-identical foreign write, a foreign write equal to the user's latest
  // keystrokes, an EOL-only skew — is no longer reported as a discard. Any OTHER
  // difference still reports, so "your edit was applied and then something else
  // was appended" still shows the notice: the claim is only that the document is
  // not carrying the user's bytes as written, and whether they were never
  // applied, overwritten, or added to is not decidable in the webview.)
  //
  // The latches are INDEPENDENT. Storm is once-per-session and OUTLIVES a
  // dismiss (edit-sync latches too; `stormNoticeShown` is the display-side
  // half). Discard is NOT latched — every discard the user has not already been
  // told about is a fresh loss — but a repeat discard while the notice is still
  // on screen is AGGREGATED: the DOM and the text are left untouched, because
  // re-rendering an identical notice reads as a new, second loss.
  //
  // Consequence of the shared slot, in BOTH directions: a discard REPLACES a
  // storm notice (showNotice's replaceChildren), and since `stormNoticeShown`
  // latched when the storm first fired, that storm is never drawn again. That
  // is deliberate — the discard states a certain loss and the storm would only
  // restate it more weakly — but it means "the storm notice disappeared" is
  // expected behaviour, not a bug to chase.
  //
  // No auto-fade: a real byte loss that disappears on a timer is back to being
  // no signal at all.
  const NOTICE_TEXT = {
    discard:
      "Quoll discarded pending edits while syncing this document. Review your recent changes and reapply anything missing; Undo cannot restore discarded edits.",
    storm:
      "Quoll has repeatedly re-synced this document. Review your recent changes; some may not have been saved.",
  } as const;
  type NoticeKind = keyof typeof NOTICE_TEXT;
  // Which claim wins the shared slot: higher is stronger. `Record<NoticeKind, …>`
  // is TOTAL, so adding a kind to NOTICE_TEXT without ranking it is a compile
  // error — the priority rule cannot silently fall behind the kind set. That
  // only guarantees the ranking is DECLARED for every kind, though; it is
  // ENFORCED in exactly one place — inside `showNotice` below — so no call
  // site (including showStormNotice's deferred render) re-derives its own
  // copy of the check. A second copy at a call site isn't merely redundant:
  // it can shadow the real one and make it permanently unreachable, which is
  // exactly what happened here before this comment was corrected.
  const NOTICE_PRIORITY: Record<NoticeKind, number> = { discard: 2, storm: 1 };
  let noticeKind: NoticeKind | null = null;
  let stormNoticeShown = false;
  function showNotice(kind: NoticeKind): void {
    if (noticeKind === kind) {
      return; // aggregate: the slot already says exactly this
    }
    // Choke point for NOTICE_PRIORITY: every writer (showDiscardNotice,
    // showStormNotice's deferred render, and any future notice producer) calls
    // through here, so this is the one place the ranking has to be checked for
    // it to actually govern who may claim the slot — re-deriving the check at
    // each call site would let a future call site forget it (and, as happened
    // once, shadow this one — see the NOTICE_PRIORITY comment above). Today
    // this declines showNotice("storm") whenever a discard already holds the
    // slot (discard outranks storm) — the exact case shell.test.ts pins as
    // "never inserts the storm notice … when a discard coincides".
    // showDiscardNotice itself is never declined here: discard is already the
    // max priority in the current kind set, so no noticeKind can outrank it —
    // this guard exists so the next kind added above discard is protected by
    // construction, not by discard happening to still be the strongest.
    if (noticeKind !== null && NOTICE_PRIORITY[noticeKind] > NOTICE_PRIORITY[kind]) {
      return; // a strictly stronger claim holds the slot — never restate it more weakly
    }
    const notice = document.createElement("div");
    notice.className = `quoll-resync-notice quoll-notice-${kind}`;
    const text = document.createElement("span");
    text.textContent = NOTICE_TEXT[kind];
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "quoll-resync-notice-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => {
      noticeHost.replaceChildren();
      noticeKind = null;
    });
    notice.append(text, dismiss);
    noticeHost.replaceChildren(notice);
    noticeKind = kind;
  }
  function showDiscardNotice(): void {
    showNotice("discard");
  }
  function showStormNotice(): void {
    if (stormNoticeShown) {
      return;
    }
    stormNoticeShown = true; // latched up-front: the deferred render cannot queue twice
    // PRIORITY: within one Document, edit-sync fires the storm (from
    // onHostSnapshot, during applyDocument) BEFORE the discard (from the
    // post-commit drain) — both synchronously, in the same task. Deferring only
    // the storm's RENDER by one microtask lets the discard, which states a
    // CERTAIN loss, claim the shared slot; a storm that would only restate it
    // more weakly is then never drawn — not even transiently, which shell.test.ts
    // records DOM mutations to pin.
    queueMicrotask(() => {
      if (shellDisposed) {
        return;
      }
      try {
        // showNotice's own priority choke point is what may decline this call
        // (a stronger claim, e.g. "discard", already holds the slot) — that
        // check is NOT re-derived here.
        showNotice("storm");
      } catch (err) {
        // An unattributed uncaught error in a microtask is indistinguishable
        // from showNotice's intentional priority decline. The latch is
        // deliberately NOT released: edit-sync latches resyncStormAlarmed
        // before calling onResyncStorm, so there is no second call to retry.
        console.error("[quoll] storm notice render failed", err);
      }
    });
  }
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
  // does NOT call shell.dispose). once:true + the latch above guard a double
  // fire. The listener is REGISTERED below — only AFTER init succeeds, next to
  // the teardown-flush listeners — never at mount, so an init failure (the
  // ready-post throw, or a mountEditor throw above — mountEditor runs outside
  // the try) does not leak it on the dead init-error page; dispose() removes it
  // symmetrically.
  const onPageHide = QUOLL_PERF ? (): void => reportSession() : null;
  // Local: a dispatch BEFORE the editor mount (e.g. a same-tick re-entry,
  // not currently possible but defensive) must not crash; editor is
  // assigned before the first message can arrive (subscribe is wired
  // synchronously after the editor mounts).

  // Single source of truth for the <html> theme classes. Both HC kinds
  // (`hc-dark` / `hc-light`) collapse to ONE `.hc-theme` class — the CSS escape
  // hatch neutralises the palette to host `--vscode-*` tokens, which already
  // differ between the two HC kinds, so the webview rounds them down here
  // (display-only). This is the ONLY place the round happens (the reducer keeps
  // the full four-value kind), so the mount-time apply and syncTheme cannot drift.
  function applyThemeClasses(el: HTMLElement, theme: WebviewState["theme"]): void {
    el.classList.toggle("dark-theme", theme === "dark");
    el.classList.toggle("light-theme", theme === "light");
    el.classList.toggle("hc-theme", theme === "hc-dark" || theme === "hc-light");
  }

  function syncTheme(prev: WebviewState, next: WebviewState): void {
    if (prev.theme === next.theme) {
      return;
    }
    applyThemeClasses(document.documentElement, next.theme);
  }

  // Initial class application from initialState. syncTheme below is a
  // prev/next diff, so without this one-shot apply, an initialState.theme
  // equal to the first Document's theme would silently leave the <html>
  // class blank (no transition → no toggle).
  applyThemeClasses(document.documentElement, state.theme);

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
      // drain — the reducer is the spec.
      if (QUOLL_PERF) {
        perfRecord("webview:dispatch", perfNow() - dispatchStart);
      }
      return;
    }
    state = next;
    syncTheme(prev, next);
    renderBanners(bannerHost, next);
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
    onResyncStorm: showStormNotice,
    onLocalEditDiscarded: showDiscardNotice,
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
        dispatch({ type: "theme", themeKind: message.themeKind });
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
        editor?.setProseLint(message.proseLint);
        editor?.setSpellcheck(message.spellcheck);
        editor?.setEditorPrefs({
          fontFamily: message.fontFamily,
          fontSize: message.fontSize,
          lineHeight: message.lineHeight,
          contentWidth: message.contentWidth,
        });
        return;
      case "format-command":
        editor?.runFormatCommand(message.action);
        return;
      case "format-document":
        editor?.runFormatDocument();
        return;
      case "caret-apply":
        // One-shot caret handoff from the host (panel became active). Pure side
        // channel: it never enters the reducer (no docVersion / write-lock) — it
        // only moves the caret. Drop silently if the editor is not mounted.
        editor?.applyRemoteCaret({ line: message.line, character: message.character });
        return;
      case "document": {
        // Identity-transition bypass (S3b): a new host session (fresh
        // epochGeneration, or a legacy host that dropped the pair) legitimately
        // restarts at a LOWER docVersion. Version ordering is meaningful only
        // WITHIN one host generation, so on a transition we SKIP the stale drop
        // and adopt the Document unconditionally — threading `adopt` so the
        // reducer's inlined copy of the same guard also adopts (otherwise the
        // webview goes permanently deaf to the live host). editor is non-null
        // whenever a stale compare could fire (docVersion only advances past 0
        // after the editor mounted), so the null-guard here is defensive.
        const isTransition =
          editor?.isIdentityTransition(message.externalEpoch, message.epochGeneration) ?? false;
        if (!isTransition && message.docVersion < state.docVersion) {
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
        editor.applyDocument(
          message.content,
          message.canWrite,
          message.docVersion,
          message.externalEpoch,
          message.epochGeneration
        );
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
          themeKind: message.themeKind,
          adopt: isTransition,
        });
        return;
      }
      default: {
        // Exhaustiveness guard — when a new HostToWebview variant is added
        // without a case here, TS flags the assignment as `never` at
        // compile time. The isHostToWebview boundary validator already
        // rejects unknown wire types, so this arm is unreachable under the
        // protocol; it documents the closed-union invariant statically.
        // Shared failure mode with the reducer's guard (state.ts) and every
        // host-side closed-union switch: THROW `[quoll] unhandled …` — fail
        // loud on an impossible state rather than silently dropping/returning.
        const _exhaustive: never = message;
        throw new Error(
          `[quoll] unhandled HostToWebview: ${(_exhaustive as { type: string }).type}`
        );
      }
    }
  });

  // Teardown flush: a real tab close destroys the iframe WITHOUT calling
  // shell.dispose()/editor.dispose() (those are test-only), so the 300 ms edit
  // debounce buffer (and the 100 ms caret-report debounce) would die un-posted
  // → silent data loss / a stranded final caret. Push the latest bytes to the
  // host on every teardown-precursor signal while the host is
  // still alive. flushPending() force-posts the latest Edit bytes even while an
  // Edit is in flight (the host stashes + drains that in-flight arrival on
  // settlement; it keeps single-flight intact on an alive hide→show) plus the
  // debounced caret, and is a
  // no-op when nothing is pending, so these are cheap: visibilitychange:hidden fires when
  // the panel hides (incl. on close, retainContextWhenHidden keeps us alive to
  // deliver it, and on switch-away); pagehide on iframe teardown; blur when
  // focus leaves toward the close affordance. The listeners are REGISTERED
  // below via attachTeardownListeners — only AFTER the ready post succeeds — so
  // an init failure (the catch nulls editor + rethrows) never leaks a listener
  // on the dead init-error page; its returned remover unwinds them symmetrically
  // in dispose().
  const flushPending = (): void => editor?.flushPending();
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

  // Register teardown listeners now that init succeeded (see the const
  // declarations above for the rationale + the no-leak-on-init-failure note).
  // onPageHide (the perf session-report listener) rides this after-init set —
  // not a mount-time registration — so neither a ready-post throw nor a
  // mountEditor throw leaks it on the dead page. The single remover keeps add
  // and remove in lockstep.
  //
  // INVARIANT: attachTeardownListeners is the ONLY registration path for these
  // listeners — never add a `window.addEventListener("pagehide"/"blur", …)` or
  // `document.addEventListener("visibilitychange", …)` directly in mountShell.
  // A stray mount-time registration would reintroduce the init-failure leak,
  // and it is NOT unit-observable: onPageHide is compiled to null under
  // QUOLL_PERF=false (every test build), so a perf-listener regression here can
  // only be caught in a perf build / manual smoke. Keep the single call below.
  const removeTeardownListeners = attachTeardownListeners({
    onPageHide,
    flushPending,
    onVisibilityChange,
  });

  return {
    dispose() {
      shellDisposed = true;
      removeTeardownListeners();
      if (QUOLL_PERF) {
        reportSession();
      }
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
