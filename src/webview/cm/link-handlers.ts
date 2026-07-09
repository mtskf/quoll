// Link interaction surface for the CodeMirror editor:
//   - tryOpenLinkAt(state, pos, host): a pure helper that resolves a
//     position to a Link node and, if the URL is safe and launchable,
//     posts an OpenExternalMessage to the host.
//   - handleLinkMouseDown(event, view, host) + quollLinkClickHandler():
//     extracted mousedown helper + the Extension factory that wires it.
//
// Why a single file: the three exports share a small private surface
// (the URL-extract + scheme check, the shared OPENABLE_SCHEMES set, the
// boundary-inclusive selection helper). Splitting would either duplicate
// the helpers or thread them through a fourth module.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { isAllowedUrl } from "../../markdown/url-allowlist.js";
import { decodeMarkdownDestination } from "../../markdown/url-decode.js";
import { MAX_HREF_LENGTH, PROTOCOL_VERSION, type WebviewToHost } from "../../shared/protocol.js";

// --- Click-to-open helper ---
//
// DRIFT WARNING (review fix #9 + R2-4): the SAME OPENABLE_SCHEMES set +
// schemeOf helper lives in src/extension/handle-open-external.ts (host
// arm). The two MUST behave identically. The host-side
// test/extension/handle-open-external.test.ts pins the host arm's
// unsafe-URL matrix; the webview-side
// test/webview/cm-link-handlers.test.ts + cm-link-integration.test.ts
// pin this side's matrix. Both matrices cover the same hostile-URL
// attack-scenario set (most rows are byte-identical; the two C0-bypass
// rows — inline `java&#10;script:...` and trailing `...example.com&#10;`
// — deliberately differ by protocol design — this side ships the raw
// entity form `&#10;` while the host arm receives the post-decode
// literal `\n`), so a drift on either side reds CI on that side. A
// shared module is rejected as scope creep (10 LOC ×2 is cheaper than
// a third file in the C9b deletion footprint).

/** Subset of the Host singleton's surface used by tryOpenLinkAt. Pinned
 *  as a structural type so tests can pass a thin spy without importing the
 *  full host module. */
export type LinkOpenHost = {
  postMessage(message: WebviewToHost): void;
};

const OPENABLE_SCHEMES = new Set(["http", "https", "mailto"]);

function schemeOf(url: string): string | null {
  // Same lowercase-first regex shape used by isAllowedUrl + the host arm.
  const match = /^([a-z][a-z0-9+.-]*):/.exec(url.toLowerCase());
  return match ? match[1] : null;
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

/** Try to open the Link at `pos`. Returns true ONLY when an open-external
 *  message was posted (caller should preventDefault on the originating
 *  event). Returns false when:
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
 *    - the URL is allowlisted but not launchable (relative / fragment).
 *  The security invariant is "post-only-when-safe-and-launchable" — the
 *  return value is a caller-convenience signal for preventDefault. */
export function tryOpenLinkAt(state: EditorState, pos: number, host: LinkOpenHost): boolean {
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
  // MAX_HREF_LENGTH guard (review fix #5): mirror the host's protocol
  // validator. Without this, an oversize href would post and the host
  // would silently reject on shape, leaving the user with a no-op click
  // AND a suppressed caret move (preventDefault fired).
  if (decoded.length > MAX_HREF_LENGTH) {
    return false;
  }
  // Defense layer 1 (webview-side): isAllowedUrl + openable-scheme gate.
  // Layer 2 (host-side handler) re-applies isAllowedUrl + an
  // OPENABLE_SCHEMES check on its end. Both must pass — defense in depth.
  // Both sides import isAllowedUrl from the same `markdown/url-allowlist`
  // module so the gate's identity cannot drift.
  if (!isAllowedUrl(decoded)) {
    return false;
  }
  const scheme = schemeOf(decoded);
  if (scheme === null || !OPENABLE_SCHEMES.has(scheme)) {
    return false;
  }
  try {
    host.postMessage({
      protocol: PROTOCOL_VERSION,
      type: "open-external",
      href: decoded,
    });
  } catch (err) {
    // Symmetric with src/webview/editor.ts postEditMessage's try/catch:
    // postMessage can throw on transport detach (panel dispose mid-click,
    // structured-clone edge cases). Log under the [quoll] grep prefix and
    // return false so the click falls through to caret-move — the only
    // signal the user has that the open did not happen.
    console.error("[quoll] postMessage(open-external) failed", err);
    return false;
  }
  return true;
}

// --- Mousedown wiring ---
//
// Split into two layers (review fix #7): handleLinkMouseDown is a pure
// helper that takes a (event, view, host) triple and pins all branching
// logic (button check, posAtCoords null guard, doc-range guard, tryOpen
// success → preventDefault). quollLinkClickHandler is the thin
// EditorView.domEventHandlers wrapper. Unit tests cover the helper's
// branches directly; the extension wrapper is a one-line delegation.

/** Pure mousedown handler. Returns true when the click was consumed (an
 *  open-external was posted AND event.preventDefault was called).
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
  // Modifier-click is left to the user: Ctrl/Cmd + click is the platform
  // convention for "open in new tab", which env.openExternal honours via
  // the system browser. Plain click and modifier click both reach this
  // handler; the only meaningful difference is browser-side and out of
  // scope (documented in Risks).
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, /* precise */ false);
  if (pos === null) {
    return false;
  }
  // posAtCoords returns the closest position; if the click is in empty
  // whitespace beyond the doc, treat as no-op.
  if (pos < 0 || pos > view.state.doc.length) {
    return false;
  }
  const handled = tryOpenLinkAt(view.state, pos, host);
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
