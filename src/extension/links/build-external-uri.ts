// Encoding-preserving external-URL → vscode.Uri builder for env.openExternal.
//
// WHY NOT Uri.parse(url): Uri.parse DECODES percent-escapes into the stored
// components (`%2F` in the path becomes `/`, unrecoverable) and re-encodes on
// serialisation, silently changing GitLab-style `%2F` API paths and `+`-bearing
// search queries. The WHATWG URL parser PRESERVES percent-encoding in
// pathname/search/hash — in particular the reported `%2F` (path) and `+`
// (query) — so splitting with it and rebuilding via Uri.from(...) keeps those
// bytes intact through to the browser: VS Code's OpenerService
// delivers the href as `encodeURI(uri.toString(true))` (skipEncoding, then an
// encodeURI that leaves %, %2F, +, %20, &, =, # untouched — read from the
// installed VS Code 1.130.0 source, `workbench.desktop.main.js`).
//
// SCOPE OF THE GUARANTEE (deliberately NOT a byte-for-byte echo of arbitrary
// input): what is preserved is the percent-encoding of path/query/fragment —
// notably `%2F` and `+`, the reported bug. `new URL()` (and Uri.from's own
// serialisation) apply destination-PRESERVING canonicalisation a browser would
// apply anyway: lower-cased scheme/host, punycoded IDN host, dropped default
// port, resolved dot-segments, `?`/`#` present only when non-empty, trailing `/`
// on a bare authority. We accept that over hand-rolling a lexical URL splitter:
// a bespoke splitter feeding an external-open is a security risk (a mis-split
// authority opens a different HOST), and Uri.from/toString(true) normalises
// regardless, so a splitter would not buy true byte-identity either. `new URL()`
// DROPS userinfo from `.host`, so the authority is rebuilt below.
//
// VERSION NOTE: the encodeURI(toString(true)) opener behaviour is a long-stable
// VS Code trait (query strings would break universally otherwise) but is an
// implementation detail, not a documented API contract. It was read from VS Code
// 1.130.0 source, while the extension's engines.vscode floor is older (~1.94), so
// the exact opener internals on the floor were not source-verified — the E2E
// asserts the Uri-level contract (which is version-independent), and the opener's
// encodeURI(toString(true)) step is the residual assumption. If external links
// ever start arriving mangled after a VS Code upgrade, re-verify this path first.

import { Uri } from "vscode";

export type ExternalUrlParts = {
  scheme: string;
  authority: string;
  path: string;
  query: string;
  fragment: string;
};

/** Split an http/https/mailto URL into still-percent-encoded Uri components.
 *  Returns null when the WHATWG parser rejects the input. Pure (no vscode). */
export function splitExternalUrl(href: string): ExternalUrlParts | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  // `url.host` is host + optional :port but DROPS userinfo — rebuild the full
  // authority so `user:pw@host` links are not silently stripped. Guard on
  // username OR password: `https://:pw@host` is valid (username === "",
  // password === "pw") and a username-only guard would drop the `:pw@`.
  const userinfo =
    url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return {
    scheme: url.protocol.replace(/:$/, ""),
    authority: userinfo + url.host,
    path: url.pathname, // WHATWG preserves %-encoding here
    query: url.search.replace(/^\?/, ""),
    fragment: url.hash.replace(/^#/, ""),
  };
}

/** Build a vscode.Uri for env.openExternal that preserves path/query/fragment
 *  percent-encoding (notably %2F and +).
 *
 *  FALLBACK: `isAllowedUrl` gates only the scheme, not full URL syntax, so a
 *  degenerate-but-allowlisted href like `https://` (no host) passes the gate yet
 *  makes `new URL()` throw → splitExternalUrl returns null. For those unparseable
 *  inputs we fall back to `Uri.parse(href)` — the pre-fix path. The
 *  encoding-preserving guarantee does NOT extend to the fallback: it is lossy
 *  exactly like the old code, and a WHATWG-rejected href could still contain
 *  `%2F`/`+` (they would be lost here). We accept that over rejecting the click:
 *  the input is already malformed enough that the WHATWG parser refused it, and
 *  falling back keeps the click working (env.openExternal + handle-open-external's
 *  toast still cover any open failure) rather than silently dropping it. */
export function buildExternalUri(href: string): Uri {
  const parts = splitExternalUrl(href);
  return parts ? Uri.from(parts) : Uri.parse(href);
}
