// The "open external URL" concern for the readonly table-cell widget's
// modifier-click path. Kept in its own module (not link-handlers.ts, which
// already owns insertLink / tryOpenLinkAt / the mousedown wiring) so the
// facet + sink stay a single, focused responsibility.
//
// Defense-in-depth layering for a table-cell link open:
//   cell-render attachLinkClickGuard — absolute scheme (ABSOLUTE_HREF_RE) +
//     MAX_HREF_LENGTH cap; anything else is preventDefault'd → caret reveal
//   → this sink — fail-closed isAllowedUrl re-check before posting
//   → host handleOpenExternal — isAllowedUrl + OPENABLE_SCHEMES (authoritative,
//     the same predicate this webview imports), then env.openExternal.
// Routing through the host is the point: the browser's native anchor handler
// would open the href WITHOUT the host re-validation.

import { Facet } from "@codemirror/state";

import { isAllowedUrl } from "../../markdown/url-allowlist.js";
import { PROTOCOL_VERSION, type WebviewToHost } from "../../shared/protocol.js";

/** Minimal host surface the sink needs — a thin structural type so tests pass
 *  a spy (identical shape to link-handlers' LinkOpenHost). */
export type OpenExternalHost = {
  postMessage(message: WebviewToHost): void;
};

/** Injectable sink for widget-originated "open external" requests. The table
 *  widget reads it at click time via `view.state.facet(...)`. Default is a
 *  no-op so a widget built without the wiring (unit tests that don't provide
 *  it) simply does not open. `combine` returns the last provider to match
 *  `quollResourceBaseUri`'s established style (one provider in production; both
 *  first- and last-wins are equivalent for a single provider). */
export const quollOpenExternalSink = Facet.define<
  (href: string) => void,
  (href: string) => void
>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : () => {}),
});

/** Build the production sink: post an `open-external` message to the host.
 *
 *  Fail-closed: re-validate `isAllowedUrl` webview-side before posting (the
 *  host re-validates too — this is redundant defense in depth against a
 *  tampered DOM href, since the caller reads `getAttribute("href")` fresh).
 *
 *  Transport-throw behaviour differs from `tryOpenLinkAt` BY DESIGN and must
 *  stay that way: the caller (`table-widget`) calls `event.preventDefault()`
 *  BEFORE invoking this sink, so a swallowed transport throw yields a
 *  dead-click (no open) rather than a native-nav fallback. Dead-click is
 *  intentional — native nav would open the href WITHOUT the host gate (the
 *  regression this routing exists to prevent), and a transport throw only
 *  happens on panel dispose mid-click. Do NOT "restore symmetry" with
 *  `tryOpenLinkAt` by letting native nav proceed on failure. */
export function openExternalSinkFor(host: OpenExternalHost): (href: string) => void {
  return (href: string) => {
    if (!isAllowedUrl(href)) {
      console.warn("[quoll] open-external sink dropped: URL not in allowlist");
      return;
    }
    try {
      host.postMessage({ protocol: PROTOCOL_VERSION, type: "open-external", href });
    } catch (err) {
      console.error("[quoll] postMessage(open-external) failed", err);
    }
  };
}
