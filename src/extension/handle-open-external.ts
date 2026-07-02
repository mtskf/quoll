// Host-side gate for webview "open-external" requests. Pure-function
// design (deps injected) so it unit-tests without a live VS Code host.
// The wire shape comes from src/shared/protocol.ts; the security gate
// is isAllowedUrl from src/markdown/url-allowlist.ts (the same predicate
// the write-gate and link-insert command consume — defense in depth).
//
// Why re-validate on the host side after the webview already gates: the
// webview is the untrusted boundary in a webview-extension architecture
// (a future bug, a CSP escape, a corrupted bundle, or a hostile
// `protocol:1`-shaped poster could feed an unsafe href). The host gate
// is the LAST line — keep it independent of webview behaviour.
//
// Why only http/https/mailto reach openExternal even though isAllowedUrl
// accepts relative paths and fragments too: openExternal launches the
// system browser/mail client, which has no notion of a relative path or
// in-document fragment without a base URL. Relative / fragment links
// should fall through (the click handler will move the caret into the
// link → reveal → user edits). The host handler refuses to launch them.
//
// DRIFT WARNING (review fix #9 + R2-4): the SAME OPENABLE_SCHEMES set +
// schemeOf helper lives in src/webview/cm/link-handlers.ts. The two MUST
// behave identically (any drift opens a fail-open hole on the host
// side). The host-side test/extension/handle-open-external.test.ts pins
// this arm's unsafe-URL matrix; the webview-side
// test/webview/cm-link-handlers.test.ts + cm-link-integration.test.ts
// pin the webview arm's matrix. Both matrices cover the same hostile-URL
// attack-scenario set (most rows are byte-identical; the two C0-bypass
// rows — inline `java&#10;script:...` and trailing `...example.com&#10;`
// — deliberately differ by protocol design — webview ships the raw
// entity form `&#10;` while this host arm receives the post-decode
// literal `\n`), so a drift on EITHER side reds CI on that side. A
// shared module is rejected as scope creep (10 LOC ×2 is cheaper than
// a third file in the C9b deletion footprint).

import { isAllowedUrl } from "../markdown/url-allowlist.js";

const OPENABLE_SCHEMES = new Set(["http", "https", "mailto"]);

/** Returns the lowercase scheme of `url`, or null if `url` has no scheme. */
function schemeOf(url: string): string | null {
  // Lowercase first so the regex is case-insensitive without a /i flag —
  // mirrors the canonicalisation in isAllowedUrl.
  const match = /^([a-z][a-z0-9+.-]*):/.exec(url.toLowerCase());
  return match ? match[1] : null;
}

/** Sanitize an untrusted href for logging. The webview-controlled string
 *  may carry C0/DEL bytes that would corrupt the Output channel
 *  presentation. Mirrors C2's `unsafeUrlError` sanitisation in
 *  src/markdown/lezer-url-walker.ts (review fix #8). */
function sanitizeForLog(href: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitising untrusted control bytes for logging.
  return href.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 64);
}

export type HandleOpenExternalDeps = {
  /** vscode.env.openExternal binding (or a test mock). Returns a Thenable
   *  per VS Code's API contract. The QuollEditorPanel wire-up wraps
   *  `(url) => env.openExternal(Uri.parse(url))`; Uri.parse can throw
   *  synchronously on malformed input that isAllowedUrl missed (review
   *  fix #6) — handleOpenExternal absorbs that throw. */
  openExternal: (url: string) => Thenable<boolean>;
};

/** Gate-and-dispatch an "open-external" request. Caller is
 *  QuollEditorPanel.handleInbound; href is the already-decoded URL string
 *  the webview sent (post decodeMarkdownDestination). */
export function handleOpenExternal(href: string, deps: HandleOpenExternalDeps): void {
  if (!isAllowedUrl(href)) {
    // Symmetric with the inbound-validation reject path in QuollEditorPanel
    // — log at console.warn so a triage report has a single greppable line.
    // Sanitised because the webview-controlled string can carry C0/DEL.
    console.warn("[quoll] open-external rejected: URL not in allowlist", {
      hrefPreview: sanitizeForLog(href),
    });
    return;
  }
  const scheme = schemeOf(href);
  if (scheme === null || !OPENABLE_SCHEMES.has(scheme)) {
    // isAllowedUrl-true but not launchable (relative / fragment / unknown
    // scheme). In normal operation the webview's mirror gate already
    // filtered this — reaching the host arm means the webview/host gates
    // have drifted (build mismatch, contributor change to one side only,
    // or a forged poster). Log at console.warn so the DRIFT WARNING
    // header above has a runtime signal, not just a CI-only signal.
    console.warn("[quoll] open-external dropped: scheme not in OPENABLE_SCHEMES", {
      scheme: scheme ?? "(none)",
      hrefPreview: sanitizeForLog(href),
    });
    return;
  }
  // Synchronous-throw guard (review fix #6): Uri.parse — called by the
  // production deps closure `(url) => env.openExternal(Uri.parse(url))` —
  // throws synchronously on inputs even non-strict mode rejects (rare
  // post-isAllowedUrl, but defense in depth). Without try/catch, that
  // throw escapes handleOpenExternal, breaks
  // QuollEditorPanel.handleInbound's switch, and corrupts subsequent
  // inbound-message handling.
  //
  // openExternal returns a Thenable<boolean>; the boolean is the platform
  // delivery signal (false = "no handler registered for this scheme") and
  // is currently ignored — surfacing it as a toast is C8 polish, see
  // Risks entry 11. The .then handles asynchronous rejection (system
  // browser missing, OS denial) symmetrically with the sync throw arm.
  try {
    void Promise.resolve(deps.openExternal(href)).then(undefined, (err: unknown) => {
      console.error("[quoll] env.openExternal rejected", err);
    });
  } catch (err) {
    console.error("[quoll] env.openExternal threw synchronously", err);
  }
}
