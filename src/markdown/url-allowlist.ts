// Single source of truth for URL scheme validation across the write-gate
// and the render-gate. The predicate is framework-agnostic and shared by
// both consumers.

const ALLOWED_URL_SCHEMES = new Set(["https", "http", "mailto"]);

// Brand for URLs that have passed the full allowlist gate (typeof string,
// non-empty after trim, no C0/DEL, no protocol-relative prefix, scheme in
// the allowlist). Prevents accidental unguarded construction in typed
// code — a caller would need an explicit `as AllowlistedUrl` assertion
// to bypass the brand, which serves as a grep-discoverable code-review
// signal. Runtime safety still comes entirely from `isAllowedUrl`; the
// brand is a marker, not a runtime guard.
declare const AllowlistedUrlBrand: unique symbol;
export type AllowlistedUrl = string & { readonly [AllowlistedUrlBrand]: true };

export function isAllowedUrl(value: unknown): value is AllowlistedUrl {
  if (typeof value !== "string") {
    return false;
  }
  // C0/DEL check on the RAW value — BEFORE String.prototype.trim() runs.
  // `.trim()` strips trailing \t / \n / \r / \f / \v, so trim-before-check
  // would silently drop trailing C0 bytes: e.g. `"https://example.com\n"`
  // → `"https://example.com"` after trim → passes. Inputs like
  // `"java\nscript:alert(1)"` (C0 in the middle) survive trim and were
  // still caught by the post-trim check, but trailing-C0 forms (which the
  // CommonMark `&#10;` entity decode emits) escaped. Gate on the raw value
  // so neither shape can bypass it. The URL parser later normalises any
  // surviving control byte back to its canonical scheme.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — we deliberately reject C0 controls + DEL to harden the URL allowlist.
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  // Reject protocol-relative URLs (`//host/path` and its backslash
  // variants). Without this they look schemeless to the regex below and
  // would be classified as "relative", but `new URL("//host/path", base)`
  // resolves them as remote network URLs. The WHATWG URL parser
  // normalizes backslashes to forward slashes in special-scheme contexts,
  // so `\\host\x`, `\/host/x`, and `/\host/x` all resolve to the same
  // external origin as `//host/x`. Match all four `[/\]{2}` prefixes.
  if (/^[/\\]{2}/.test(trimmed)) {
    return false;
  }
  // Single-source the case-folding: lowercase the input before the
  // scheme regex so the regex is lowercase-only. The `/i` flag is
  // redundant when the input is already canonicalized, and dropping it
  // keeps "scheme matching is case-insensitive" expressed in exactly
  // one place (the .toLowerCase() call) rather than two.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/.exec(trimmed.toLowerCase());
  if (!schemeMatch) {
    return true; // relative path or fragment
  }
  return ALLOWED_URL_SCHEMES.has(schemeMatch[1]);
}

export type RenderSafeUrl = { kind: "safe"; url: AllowlistedUrl } | { kind: "blocked" };

/**
 * Render-gate that widgets call before emitting a live `<a href>` /
 * `<img src>` / equivalent. Returns the trimmed, allowlisted value on
 * safe inputs and `{ kind: "blocked" }` otherwise — the widget then
 * renders an inert placeholder (never a live network request). Wraps
 * `isAllowedUrl` to keep one choke point.
 */
export function renderSafeUrl(raw: unknown): RenderSafeUrl {
  if (!isAllowedUrl(raw)) {
    return { kind: "blocked" };
  }
  // `raw` is now branded `AllowlistedUrl`; `isAllowedUrl` checks the
  // trimmed value, so the trimmed form preserves the same invariants
  // (the trim removes leading/trailing whitespace only and cannot
  // introduce C0/DEL bytes, protocol-relative prefixes, or a blocked
  // scheme). Re-asserting the brand on the trimmed string is safe.
  return { kind: "safe", url: raw.trim() as AllowlistedUrl };
}

/**
 * Mint an AllowlistedUrl for a webview-resource URI produced by resolving an
 * already-gated RELATIVE image destination against a TRUSTED host base
 * (webview.asWebviewUri output). Trust is scheme-agnostic ON PURPOSE: a
 * non-protocol-relative relative reference resolved against `base` keeps the
 * base's scheme + authority, so we confirm the result stays on the host's own
 * resource origin WITHOUT hard-coding `https` — a future VS Code change back to
 * a `vscode-resource:`-style scheme must keep working.
 *
 * We compare `protocol` + `host` (NOT `URL.origin`): opaque-origin schemes such
 * as `vscode-resource:` serialize `origin` as the string "null" for EVERY URL,
 * so an origin-string comparison would either (a) reject all of them — breaking
 * the very future-proofing this helper exists for — or (b) treat two distinct
 * opaque origins as equal ("null" === "null"). `protocol` + `host` is
 * meaningful for both special (https) and opaque (vscode-resource) schemes:
 * `host` = hostname + port, and protocol-relative / cross-host escapes change
 * `host` (or `protocol`) and are rejected. Returns null when `base` does not
 * parse, the join fails, or scheme/authority escapes. This helper owns the SOLE
 * `as AllowlistedUrl` cast for resolved values.
 */
export function resolveTrustedResourceUrl(relative: string, base: string): AllowlistedUrl | null {
  let baseUrl: URL;
  try {
    baseUrl = new URL(base);
  } catch {
    return null;
  }
  let resolved: URL;
  try {
    resolved = new URL(relative, base);
  } catch {
    return null;
  }
  if (resolved.protocol !== baseUrl.protocol || resolved.host !== baseUrl.host) {
    return null;
  }
  return resolved.href as AllowlistedUrl;
}
