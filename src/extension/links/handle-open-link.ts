// Host-side gate for webview "open-link" requests — phase-1 page-to-page
// navigation. Pure-function design (deps injected) so it unit-tests without a
// live VS Code host, mirroring src/extension/handle-open-external.ts.
//
// The webview owns NO path: it posts only the decoded relative destination
// string (post decodeMarkdownDestination). This handler re-derives everything
// and NEVER trusts it — see the plan's "Threat model" section for the encoded-
// segment, symlink, scheme-parity, case-sensitivity, and disposed-panel
// rationale. In order it:
//   - re-applies isAllowedUrl (rejects C0/DEL + protocol-relative //host — the
//     SAME host-side re-validation handle-open-external.ts applies),
//   - strips a trailing #fragment,
//   - rejects a scheme-bearing / absolute / non-.md destination,
//   - resolves the remainder against THIS document's directory (host owns
//     document.uri),
//   - requires the resolved target to be inside a workspace folder OR (no
//     workspace / escaped) inside the document's own directory subtree,
//   - opens it via the injected openWith (production: openInQuollEditor +
//     QuollEditorPanel.viewType).
//
// Security-gate rejections are log-only (console.warn under [quoll]); a
// user-visible toast is reserved for a genuine open FAILURE (openWith
// rejects/throws) — identical posture to handle-open-external.ts.

import type { Uri } from "vscode";
import { isAllowedUrl } from "../../markdown/url-allowlist.js";

/** User-facing toast when a resolved, in-scope target still fails to open
 *  (openWith rejects/throws). Mirrors OPEN_EXTERNAL_FAILURE_MESSAGE. */
const OPEN_LINK_FAILURE_MESSAGE =
  "Quoll: couldn't open the linked file. See the extension host log for details.";

/** Sanitize an untrusted href for logging (C0/DEL → '?', truncate). Mirrors
 *  handle-open-external.ts's sanitizeForLog. */
function sanitizeForLog(href: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitising untrusted control bytes for logging.
  return href.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 64);
}

/** True when `target` is `dir` itself or a descendant (same scheme + authority
 *  + path-prefix). `dir.path` normalized to exactly one trailing slash so `/ws`
 *  does not match `/ws-evil/x`. Case-sensitive by design (see plan threat
 *  model — a case-insensitive FS can only over-block, never bypass). */
function isWithinDir(target: Uri, dir: Uri): boolean {
  if (target.scheme !== dir.scheme || target.authority !== dir.authority) {
    return false;
  }
  const dirPath = dir.path.replace(/\/?$/, "/");
  return target.path === dir.path || target.path.startsWith(dirPath);
}

export type HandleOpenLinkDeps = {
  /** THIS document's Uri — the host owns it; the webview never sends a path. */
  documentUri: Uri;
  /** `Uri.joinPath` binding (or a test stub). Normalizes `.`/`..` segments. */
  joinPath: (base: Uri, ...segments: string[]) => Uri;
  /** `workspace.getWorkspaceFolder(uri) !== undefined` (or a test stub). */
  isInWorkspace: (uri: Uri) => boolean;
  /** Production: `(uri) => openInQuollEditor(uri, QuollEditorPanel.viewType)`.
   *  The viewType is bound by the caller so this module never names it. */
  openWith: (uri: Uri) => Thenable<unknown>;
  /** The panel's hoisted showError closure (harness-recorded + rejection-safe)
   *  — NOT a bare window.showErrorMessage. Surfaces the failure toast. */
  showError: (message: string) => void;
};

/** Gate-and-dispatch an "open-link" request. Caller is
 *  QuollEditorPanel.handleInbound; `href` is the already-decoded relative
 *  destination string the webview sent (post decodeMarkdownDestination). */
export function handleOpenLink(href: string, deps: HandleOpenLinkDeps): void {
  // 1. Host re-validation (C0/DEL, protocol-relative, disallowed scheme).
  if (!isAllowedUrl(href)) {
    console.warn("[quoll] open-link rejected: URL not in allowlist", {
      hrefPreview: sanitizeForLog(href),
    });
    return;
  }

  const hashIdx = href.indexOf("#");
  const pathPart = hashIdx >= 0 ? href.slice(0, hashIdx) : href;

  if (pathPart.length === 0) {
    console.warn("[quoll] open-link dropped: empty path (fragment-only)", {
      hrefPreview: sanitizeForLog(href),
    });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(pathPart)) {
    // isAllowedUrl accepts mailto:/http: — but open-link targets are schemeless.
    console.warn("[quoll] open-link dropped: destination has a scheme", {
      hrefPreview: sanitizeForLog(href),
    });
    return;
  }
  if (pathPart.startsWith("/") || pathPart.includes("\\")) {
    // Reject absolute `/…` and ANY backslash: markdown paths use `/`, and a `\`
    // is normalized as a separator by real Uri.joinPath (Windows) but not by the
    // test stub — rejecting it makes separator semantics moot for containment.
    console.warn("[quoll] open-link dropped: absolute path or backslash", {
      hrefPreview: sanitizeForLog(href),
    });
    return;
  }
  if (!/\.md$/i.test(pathPart)) {
    console.warn("[quoll] open-link dropped: not a .md target", {
      hrefPreview: sanitizeForLog(href),
    });
    return;
  }

  const dir = deps.joinPath(deps.documentUri, "..");
  const target = deps.joinPath(dir, pathPart);

  // Fail-closed containment: inside a workspace folder, OR (no workspace /
  // escaped the workspace) inside the document's own directory subtree.
  //
  // Encoded segments do NOT traverse: decodeMarkdownDestination does not
  // percent-decode and Uri.joinPath does not treat a literal `%2f`/`%5c` as a
  // separator, so `..%2f..%2fx.md` resolves to a single literal (non-existent)
  // filename INSIDE `dir` — never an escape. Containment is asserted on the
  // resolved `target`, authoritative regardless of encoding. (The image-write
  // gate in url-allowlist.ts decodes per segment because it validates absolute
  // resolved URLs; this handler only joins relative segments onto `dir`, so the
  // literal-separator property suffices.) A literal `%` is deliberately NOT
  // rejected so a legitimate `%20`-in-filename link still opens.
  //
  // A rejection here is log-only by design: the webview cannot evaluate
  // containment (it owns no path), so a containment-refused click is a normal
  // reachable outcome for out-of-workspace user content. The webview has already
  // preventDefault'd, so such a click neither navigates nor moves the caret nor
  // toasts — an accepted phase-1 trade-off (refusing to confirm an escape is the
  // safer default; a recovery `open-link-rejected` channel is deferred).
  if (!deps.isInWorkspace(target) && !isWithinDir(target, dir)) {
    console.warn("[quoll] open-link dropped: target outside workspace/document dir", {
      hrefPreview: sanitizeForLog(href),
    });
    return;
  }

  // openWith returns a Thenable; a synchronous throw or an async rejection both
  // surface the failure toast so a dead click is never silent. Mirrors
  // handleOpenExternal's failure handling.
  try {
    void Promise.resolve(deps.openWith(target)).then(undefined, (err: unknown) => {
      console.error("[quoll] open-link openWith rejected", err);
      deps.showError(OPEN_LINK_FAILURE_MESSAGE);
    });
  } catch (err) {
    console.error("[quoll] open-link openWith threw synchronously", err);
    deps.showError(OPEN_LINK_FAILURE_MESSAGE);
  }
}
