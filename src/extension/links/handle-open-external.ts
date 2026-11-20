// Host-side gate for webview "open-external" requests. Unit tests can
// inject an opener without a live VS Code host.
// The wire shape comes from src/shared/protocol.ts; the security gate
// is isAllowedUrl from src/markdown/url-allowlist.ts (the same predicate
// render, open-link and link-insert consumers use — defense in depth).
//
// Why re-validate on the host side after the webview already gates: the
// webview is the untrusted boundary in a webview-extension architecture
// (a future bug, a CSP escape, a corrupted bundle, or a hostile
// protocol-valid poster could feed an unsafe href). The host gate
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
// schemeOf helper lives in src/webview/cm/link-target.ts (it moved there
// from cm/link-handlers.ts when classification was extracted so the click
// handler and the pointer-cursor decoration could share one predicate). The
// two MUST behave identically (any drift opens a fail-open hole on the host
// side). The host-side test/extension/links/handle-open-external.test.ts pins
// this arm's unsafe-URL matrix; the webview-side
// test/webview/cm-link-handlers.test.ts + cm-link-target.test.ts +
// test/webview/decorations/cm-link-integration.test.ts
// pin the webview arm's matrix. Both matrices cover the same hostile-URL
// attack-scenario set (most rows are byte-identical; the two C0-bypass
// rows — inline `java&#10;script:...` and trailing `...example.com&#10;`
// — deliberately differ by protocol design — webview ships the raw
// entity form `&#10;` while this host arm receives the post-decode
// literal `\n`), so a drift on EITHER side reds CI on that side. A
// shared module is rejected as scope creep (10 LOC ×2 is cheaper than
// a third file in the C9b deletion footprint).

import { isAllowedUrl } from "../../markdown/url-allowlist.js";
import { openExternalUrl } from "./open-external-url.js";

const OPENABLE_SCHEMES = new Set(["http", "https", "mailto"]);

/** User-facing toast shown when a gated, launchable URL still fails to open.
 *  Covers a fulfilled `false`, an async rejection, or a synchronous throw.
 *  On the verbatim path, `vscode.open` resolves void, so only a rejection signals
 *  failure. Details go to the host log. */
const OPEN_EXTERNAL_FAILURE_MESSAGE =
  "Quoll: couldn't open the link. See the extension host log for details.";

/** Returns the lowercase scheme of `url`, or null if `url` has no scheme. */
function schemeOf(url: string): string | null {
  // Lowercase first so the regex is case-insensitive without a /i flag —
  // mirrors the canonicalisation in isAllowedUrl.
  const match = /^([a-z][a-z0-9+.-]*):/.exec(url.toLowerCase());
  return match ? match[1] : null;
}

/** Sanitize an untrusted href for logging. The webview-controlled string
 *  may carry C0/DEL bytes that would corrupt the Output channel
 *  presentation. Sanitize before logging untrusted destinations. */
function sanitizeForLog(href: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitising untrusted control bytes for logging.
  return href.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 64);
}

export type HandleOpenExternalDeps = {
  /** Unit tests can override the default opener. */
  openExternal?: (url: string) => Thenable<boolean>;
  /** Host showError (a window.showErrorMessage wrapper). Surfaces a
   *  user-visible toast when a launch fails so a failed link click is not
   *  silently dropped. Required so callers always provide failure feedback. */
  showError: (message: string) => void;
};

/** Gate-and-dispatch an "open-external" request. Caller is
 *  QuollEditorPanel.handleInbound; href is the already-decoded URL string
 *  the webview sent (post decodeMarkdownDestination). */
export function handleOpenExternal(
  href: string,
  { openExternal = openExternalUrl, showError }: HandleOpenExternalDeps
): void {
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
  // Keep synchronous throws from the injected opener within this handler.
  // A fulfilled false on the Uri path or a rejection from either path
  // also gets a toast and a host log entry.
  try {
    void Promise.resolve(openExternal(href)).then(
      (delivered: boolean) => {
        if (!delivered) {
          showError(OPEN_EXTERNAL_FAILURE_MESSAGE);
          console.warn("[quoll] open-external returned false");
        }
      },
      (err: unknown) => {
        showError(OPEN_EXTERNAL_FAILURE_MESSAGE);
        console.error("[quoll] open-external rejected", err);
      }
    );
  } catch (err) {
    showError(OPEN_EXTERNAL_FAILURE_MESSAGE);
    console.error("[quoll] open-external threw synchronously", err);
  }
}
