// Webview-resource base URI for the open document, exposed as a CodeMirror
// facet so image renderers can resolve a relative image path against the
// document's location. Static per editor (set once at mount from the host's
// data-resource-base-uri attribute); never reconfigured at runtime. Empty
// string ("") means "no base" (non-file document) → relative images are left
// unresolved (rendered inert by the callers' render-gates).
//
// This module also owns `resolveAgainstBase` — the ONE render-side
// resolve+containment policy for image sources. Both consumers route through
// it so they cannot drift:
//   - the block-image widget  (image/image-field.ts)
//   - the table-cell renderer (table/cell-render.ts)
// It lives here (not in image-field.ts) because image-field.ts imports from
// cell-render.ts (commonMarkAltText), so cell-render.ts importing the resolver
// from image-field.ts would create an import cycle.

import { Facet } from "@codemirror/state";
import { type AllowlistedUrl, resolveTrustedResourceUrl } from "../../../markdown/url-allowlist.js";

export const quollResourceBaseUri = Facet.define<string, string>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : ""),
});

// Diagnostic latch: a relative-resolution failure (a present base plus a
// relative path that won't resolve/trust) is logged ONCE per webview session.
// Without a latch a malformed base would spam a warning for every relative
// image on every document change; one line is enough to triage. The reachable
// case in normal operation is a `../` destination escaping the document
// directory (resolveTrustedResourceUrl's containment check rejects it); the
// breadcrumb tells the author why the inert placeholder rendered.
let warnedUnresolvableImage = false;

/** Resolve a gated image URL against the document's base URI for rendering.
 *  - Absolute URLs (parse standalone — http(s)/mailto) pass through unchanged;
 *    remote http(s) stay CSP-blocked at render (the caller's concern).
 *  - A relative URL is resolved + scheme/authority/containment-checked +
 *    branded by resolveTrustedResourceUrl (scheme-agnostic; survives a VS Code
 *    resource-scheme change — see url-allowlist.ts). We deliberately do NOT
 *    re-run renderSafeUrl on the resolved value (its http/https/mailto
 *    allowlist would reject a non-https resource scheme).
 *  Returns null (→ inert placeholder) for: no base (non-file doc), a
 *  fragment-/query-only destination (resolves to the document FILE itself,
 *  never an image), a `../` destination escaping the document directory, or a
 *  resolve/authority-check failure (logged once). */
export function resolveAgainstBase(url: AllowlistedUrl, base: string): AllowlistedUrl | null {
  let isAbsolute = false;
  try {
    new URL(url);
    isAbsolute = true;
  } catch {
    isAbsolute = false;
  }
  if (isAbsolute) {
    return url;
  }
  if (base === "") {
    return null; // non-file document: no folder to resolve against (expected)
  }
  if (url.startsWith("#") || url.startsWith("?")) {
    return null; // fragment-/query-only → the document file, not an image
  }
  const resolved = resolveTrustedResourceUrl(url, base);
  if (resolved === null && !warnedUnresolvableImage) {
    warnedUnresolvableImage = true;
    console.warn("[quoll] relative image could not be resolved against the document base", { url });
  }
  return resolved;
}
