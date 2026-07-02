// The SINGLE render-side decode→gate choke point. Composes the two pure
// primitives — `decodeMarkdownDestination` (CommonMark angle-bracket strip +
// backslash escapes + character references; src/markdown/url-decode.ts) and
// `renderSafeUrl` (the URL-scheme allowlist gate; src/markdown/url-allowlist.ts)
// — so BOTH render callers route through one function and CANNOT drift apart:
//   - the block-image widget  (src/webview/cm/image/image-field.ts)
//   - the table-cell renderer (src/webview/cm/table/cell-render.ts), for
//     inline links / images / autolinks.
//
// Kept in its own module (rather than folded into url-decode.ts) so each layer
// keeps a single responsibility: url-decode = pure decode, url-allowlist = pure
// gate, this = the render-side composition. Both imports are framework-agnostic
// (no @codemirror / DOM), so this module is safe to import from either bundle.
//
// Decode MUST run BEFORE the gate: without it, `javascript&#58;…` /
// `javascript\:…` look schemeless to `isAllowedUrl`'s regex, classify as
// "relative", and would ship as a live `<a href>` / `<img src>` that the
// browser resolves back into a dangerous scheme → XSS. The decoder's
// undecodable-reference fallback is NUL, which `isAllowedUrl`'s C0 check rejects
// — so any reference outside the curated URL-impactful set fails closed.
//
// Pure: no throw on any input (decodeMarkdownDestination guards
// String.fromCodePoint via decodableCodePoint; renderSafeUrl is total).

import { type RenderSafeUrl, renderSafeUrl } from "./url-allowlist.js";
import { decodeMarkdownDestination } from "./url-decode.js";

/**
 * Decode a raw Markdown link/image destination slice and gate it through the
 * URL allowlist in one step. Returns `{ kind: "safe", url }` (caller emits a
 * live href/src) or `{ kind: "blocked" }` (caller renders inert source text /
 * a placeholder).
 */
export function renderSafeMarkdownDestination(rawSlice: string): RenderSafeUrl {
  return renderSafeUrl(decodeMarkdownDestination(rawSlice));
}
