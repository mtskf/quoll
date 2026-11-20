// Build a Uri for the non-verbatim external-open path (mailto and remote windows).
// The WHATWG split keeps percent escapes in the stored components, while
// Uri.parse would decode them. VS Code 1.94 applies encodeURI to the Uri
// handoff, so an escape such as %2F can still arrive as %252F.
//
// new URL() also canonicalises the scheme, host, port and dot-segments.
// It omits userinfo from .host, so the authority is rebuilt below.

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
