// Link interaction surface for the CodeMirror editor:
//   - tryOpenLinkAt(state, pos, host, scrollTo): resolves a position to a Link
//     node and, when the destination is actionable, either posts the matching
//     message to the host — `open-external` for a launchable http/https/mailto
//     URL, `open-link` for a relative `.md` target — or, for a same-document
//     `#slug` whose heading exists, calls the injected scroll sink with that
//     heading's offset. The fragment arm is the one actionable class that needs
//     no host: the document is right here.
//   - handleLinkMouseDown(event, view, host) + quollLinkClickHandler():
//     extracted mousedown helper + the Extension factory that wires it.
//
// Why a single file: the three exports form one call chain —
// quollLinkClickHandler wires handleLinkMouseDown into CodeMirror, which
// exists only to feed tryOpenLinkAt — so splitting them would thread a
// one-line delegation through a fourth module for no gain. (They do NOT share
// helpers: selectionIntersects, warnLinkNotOpened and postToHost each have
// exactly one caller, tryOpenLinkAt.)
//
// What this file no longer owns is the CLASSIFICATION of a destination: that
// moved to ./link-target.js so the click handler and the
// `quoll-link-clickable` decoration decide "does this act?" from one predicate
// instead of two drifting copies. This file keeps the LOGGING policy on top of
// that verdict.
// Classification lives in ./link-target.js (pure) and the document question —
// "does this `#slug` name a real heading?" — in ./link-resolve.js. This file
// switches on the RESOLVED verdict and keeps only the LOGGING policy on top.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { decodeMarkdownDestination } from "../../markdown/url-decode.js";
import { MAX_HREF_LENGTH, PROTOCOL_VERSION, type WebviewToHost } from "../../shared/protocol.js";
import { type PostMessageHost, safePostMessage } from "../safe-post-message.js";
import { resolveLinkTarget } from "./link-resolve.js";
import { classifyLinkTarget } from "./link-target.js";

/** Forced-parse budget for resolving a `#slug` on CLICK. Same value and same
 *  reasoning as outline-panel.ts's PARSE_BUDGET_MS: a user-initiated, one-shot
 *  action may spend real time completing the parse, because the alternative is
 *  silently failing to find a heading that exists (syntaxTree only guarantees
 *  the viewport +~100 KB). Keystroke-adjacent paths in this codebase use a much
 *  smaller budget (url-link-paste.ts's 50 ms) — a click is not one of those. */
const FRAGMENT_PARSE_BUDGET_MS = 500;

// --- Click-to-open helper ---
//
// DRIFT WARNING: the classification cascade (OPENABLE_SCHEMES, schemeOf, the
// relative-.md arm) lives in ./link-target.js now — see that module's header
// for the drift contract against src/extension/links/handle-open-external.ts
// (host arm).

/** Alias of the safe-post-message host shape (not the full Host singleton),
 *  so tests can pass a thin spy without importing the full host module. */
export type LinkOpenHost = PostMessageHost;

/** Where the fragment arm sends its resolved document offset. Injected for the
 *  same reason `host` is: it keeps tryOpenLinkAt a function of `state` alone, so
 *  the 20-odd classification tests stay state-only instead of having to build an
 *  EditorView under happy-dom (which has no layout). handleLinkMouseDown owns
 *  the one place a view is dispatched on. */
export type InDocumentScrollSink = (pos: number) => void;

/** Post a webview→host message, swallowing a transport throw (panel dispose
 *  mid-click, structured-clone edge cases) under the [quoll] grep prefix and
 *  returning false so the click falls through to a caret move — the same
 *  fall-through open-external already relies on (intentional parity; not a new
 *  risk). Shared by the open-external and open-link branches of tryOpenLinkAt. */
function postToHost(host: LinkOpenHost, message: WebviewToHost): boolean {
  return safePostMessage(host, message, "link-open");
}

/** Log a gate-reject bail: tryOpenLinkAt declines to open and returns false.
 *  This is NOT a "dead click" in the sense open-external.ts /
 *  handle-open-link.ts use the term — those run AFTER preventDefault has
 *  fired, so their failure truly consumes the click; none of these bails
 *  call preventDefault, so the click falls through to CodeMirror's default
 *  caret placement. Warned under the `[quoll]` grep prefix so a "this link
 *  does nothing" report has a triage trail — mirrors `openExternalSinkFor`'s
 *  warn (open-external.ts) for the allowlist condition the two share.
 *
 *  NO-URL POLICY (do not relax): no value in `detail` may carry bytes that came
 *  from the href. ENFORCED in ./link-target.js rather than upheld by each call
 *  site here: every string field a `LinkTarget` rejection arm carries is already
 *  PICKED from a set of source literals (that module's header names them) — so
 *  this function's callers can pass any rejection-arm field through. The webview
 *  console is user-visible surface and the destination can be hostile or
 *  merely private; the host arm sanitises before it logs a preview, this side
 *  has no sanitiser, so it echoes nothing. */
function warnLinkNotOpened(reason: string, detail: Record<string, unknown>): void {
  console.warn(`[quoll] link not opened: ${reason}`, detail);
}

function selectionIntersects(state: EditorState, from: number, to: number): boolean {
  // Boundary-inclusive — mirror of linkReveal's intersectsAnySelection so
  // the click contract is symmetric with the visual REVEAL state. A
  // caret AT the closing `)` counts as inside the link (consistent with
  // the inline-mark contract C4a established).
  for (const r of state.selection.ranges) {
    if (r.from <= to && r.to >= from) {
      return true;
    }
  }
  return false;
}

/** Try to open the Link at `pos`. Returns true when the click was ACTED on —
 *  a host message was posted (`open-external` / `open-link`) OR a
 *  same-document fragment resolved and `scrollTo` was called. The caller
 *  should preventDefault on the originating event. Returns false when:
 *    - the position is not inside a Link node, or
 *    - the Link has no URL child (reference-form), or
 *    - the CURRENT selection already intersects the Link (review fix #4:
 *      caret-in-link → REVEALED state → the click is a caret reposition,
 *      not an open), or
 *    - the URL exceeds MAX_HREF_LENGTH (review fix #5: webview-side cap
 *      mirrors the host validator so an oversize URL falls through
 *      instead of posting + getting silently rejected at the host shape
 *      check), or
 *    - the URL is non-allowlisted (post-decode), or
 *    - the URL is allowlisted but not launchable AND not a relative `.md`
 *      target (an unknown scheme, a fragment, an absolute path, or a
 *      schemeless non-.md relative → falls through to a caret move), or
 *    - the destination is a `#slug` that no heading in this document produces
 *      (falls through to a caret move — `decorations/link-reveal.ts`
 *      withheld the pointer cursor for it too, via the same resolution).
 *  The security invariant is "post-only-when-safe-and-launchable-or-a-
 *  relative-.md-target" — the return value is a caller-convenience signal
 *  for preventDefault. The gate-reject bails (oversize href, allowlist
 *  reject, non-openable scheme) additionally log a console.warn via
 *  `warnLinkNotOpened` for triage. The remaining false-returning branches are
 *  silent: the pre-classification ones (not a Link, reference-form,
 *  caret-in-link) are ordinary UI states, and the `no-action` arm is
 *  deliberately silent because `decorations/link-reveal.ts` withholds the
 *  pointer cursor for that class. */
export function tryOpenLinkAt(
  state: EditorState,
  pos: number,
  host: LinkOpenHost,
  scrollTo: InDocumentScrollSink
): boolean {
  const tree = syntaxTree(state);
  let node = tree.resolveInner(pos, 0);
  while (node.parent !== null && node.name !== "Link") {
    node = node.parent;
  }
  if (node.name !== "Link") {
    return false;
  }
  // Revealed-link guard (review fix #4): when the caret is already inside
  // the Link, the click should land as a caret reposition, NOT an open.
  if (selectionIntersects(state, node.from, node.to)) {
    return false;
  }
  // Find the URL child. Reference-form Link has none.
  let child = node.firstChild;
  let urlNode: { from: number; to: number } | null = null;
  while (child !== null) {
    if (child.name === "URL") {
      urlNode = { from: child.from, to: child.to };
      break;
    }
    child = child.nextSibling;
  }
  if (urlNode === null) {
    return false;
  }
  const raw = state.sliceDoc(urlNode.from, urlNode.to);
  const decoded = decodeMarkdownDestination(raw);
  // Classify (pure), then answer the document question. The budget is spent
  // only if the arm is a fragment — see resolveLinkTarget. This switch adds
  // only the LOGGING policy on top; every field below is already
  // NO-URL-POLICY-safe by construction (see link-target.ts's header).
  const target = resolveLinkTarget(
    state,
    tree,
    classifyLinkTarget(decoded),
    FRAGMENT_PARSE_BUDGET_MS
  );
  switch (target.kind) {
    case "external":
      return postToHost(host, {
        protocol: PROTOCOL_VERSION,
        type: "open-external",
        href: target.href,
      });
    case "workspace":
      return postToHost(host, { protocol: PROTOCOL_VERSION, type: "open-link", href: target.href });
    case "scroll":
      // Resolved by the SAME function link-reveal used to decide the pointer
      // cursor, so a link that looked clickable acts. An unmatched slug never
      // reaches here — it resolved to `no-action`, which is silent by design:
      // it never showed a pointer, and a warn would echo href-derived bytes,
      // which the NO-URL POLICY forbids.
      scrollTo(target.pos);
      return true;
    case "oversize":
      warnLinkNotOpened("URL exceeds MAX_HREF_LENGTH", {
        length: target.length,
        max: MAX_HREF_LENGTH,
      });
      return false;
    case "blocked":
      // Deliberately not a copy of either host-arm branch: the host's
      // allowlist-reject branch logs a sanitised, 64-capped hrefPreview and no
      // scheme at all, and its bare `scheme ?? "(none)"` shape belongs to the
      // POST-allowlist branch mirrored below.
      warnLinkNotOpened("URL not in allowlist", { scheme: target.schemeToken });
      return false;
    case "unopenable-scheme":
      warnLinkNotOpened("scheme not in OPENABLE_SCHEMES", { scheme: target.scheme });
      return false;
    case "no-action":
      // Absolute paths, non-.md relatives, fragments that slug to nothing,
      // and fragments naming no heading in this document: ordinary Markdown
      // Quoll does not route. Silent BY DESIGN — a warn here would fire on
      // every table-of-contents click and drown the three real signals
      // above. The dead-click affordance is fixed at its source instead:
      // decorations/link-reveal.ts withholds the pointer cursor for exactly
      // this class (isActionableLinkTarget), so the click never looked
      // available and there is nothing to explain.
      return false;
  }
}

// --- Mousedown wiring ---
//
// Split into two layers (review fix #7): handleLinkMouseDown is a pure
// helper that takes a (event, view, host) triple and pins all branching
// logic (button check, posAtCoords null guard, doc-range guard, tryOpen
// success → preventDefault). quollLinkClickHandler is the thin
// EditorView.domEventHandlers wrapper. Unit tests cover the helper's
// branches directly; the extension wrapper is a one-line delegation.

/** Production fragment sink: move the caret to the heading, bring it to the top
 *  of the viewport, and take keyboard focus. Mirrors the outline panel's jumpTo
 *  (cursor + `y: "start"` scrollIntoView + focus) so the two ways of jumping to
 *  a heading land identically.
 *
 *  The `view.focus()` is load-bearing, not copied ceremony: handleLinkMouseDown
 *  calls preventDefault on the MOUSEDOWN, and moving DOM focus onto the clicked
 *  contenteditable is precisely that event's default action. The two existing
 *  preventDefault handlers (open-external / open-link here, open-code-reference
 *  in code-ref/code-ref-handlers.ts) only post to the host and never touch local
 *  selection, so the suppressed focus never showed. This is the first arm that
 *  moves the caret locally: without the focus call, a click made while the view
 *  does not already hold focus — a table-of-contents click as the first
 *  interaction, or focus sitting in the outline panel — would scroll and place a
 *  caret the user then cannot type into. Idempotent when already focused.
 *
 *  `pos` is a heading line start that resolveLinkTarget derived from this same
 *  state, so it is in range by construction. */
function scrollToDocumentPos(view: EditorView, pos: number): void {
  view.dispatch({
    selection: EditorSelection.cursor(pos),
    effects: EditorView.scrollIntoView(pos, { y: "start" }),
  });
  view.focus();
}

/** Pure mousedown handler. Returns true when the click was consumed (a
 *  host message — `open-external` for a launchable URL OR `open-link` for a
 *  relative `.md` target — was posted AND event.preventDefault was called).
 *  Extracted from quollLinkClickHandler so the branches (button !== 0,
 *  posAtCoords null, out-of-range pos, tryOpenLinkAt false) are testable
 *  without synthesising real coords-based mousedown events under
 *  happy-dom (which has no layout). */
export function handleLinkMouseDown(
  event: MouseEvent,
  view: EditorView,
  host: LinkOpenHost
): boolean {
  // Left-click only. Right / middle click stay as plain browser events
  // (context menu / paste).
  if (event.button !== 0) {
    return false;
  }
  // Modifier-click is left to the user: for an external URL, Ctrl/Cmd + click
  // is the platform "open in new tab" convention, which env.openExternal honours
  // via the system browser; for a relative `.md` target it routes in-editor
  // through the host `open-link` path either way. Plain click and modifier click
  // both reach this handler; the only meaningful difference is browser-side (for
  // external URLs) and out of scope (documented in Risks).
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, /* precise */ false);
  if (pos === null) {
    return false;
  }
  // posAtCoords returns the closest position; if the click is in empty
  // whitespace beyond the doc, treat as no-op.
  if (pos < 0 || pos > view.state.doc.length) {
    return false;
  }
  const handled = tryOpenLinkAt(view.state, pos, host, (headingPos) =>
    scrollToDocumentPos(view, headingPos)
  );
  if (handled) {
    event.preventDefault();
    return true;
  }
  return false;
}

/** Build the click-to-open extension. Caller passes a `host` (the
 *  singleton from src/webview/host.ts in production, a spy in tests) so
 *  the extension is dep-injected and free of module-level singletons —
 *  matches the design of the other webview extension factories. */
export function quollLinkClickHandler(host: LinkOpenHost) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      return handleLinkMouseDown(event, view, host);
    },
  });
}
