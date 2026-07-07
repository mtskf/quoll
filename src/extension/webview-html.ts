// Pure HTML/CSP construction for the custom editor webview.
//
// Why extracted: the CSP string is the single most security-sensitive
// configuration the extension emits. Unit-testing it inline in
// QuollEditorPanel.getWebviewContent requires a live `Webview` value;
// extracting the string-construction into a pure function lets us
// pin every CSP directive (default-deny, nonce binding, no unsafe-eval,
// constrained image/font sources) with a Vitest assertion that runs in
// milliseconds — and a regression flips a single test red instead of
// shipping silently.
//
// localResourceRoots is configured at the call site (panel.webview.options),
// not here — it is a runtime configuration on the Webview instance, not a
// part of the HTML payload.

export type BuildWebviewHtmlInput = {
  /**
   * webview.cspSource — a CSP source list (NOT a single URL). The real VS Code
   * value is e.g. `'self' https://*.vscode-cdn.net`: space-separated tokens
   * mixing quoted keywords (`'self'`) and source expressions. Validated per
   * token in buildWebviewHtml (see CSP_KEYWORD_RE / CSP_SOURCE_TOKEN_RE).
   */
  cspSource: string;
  /** Webview-safe URI for dist/webview/index.js as a string. */
  scriptUri: string;
  /** Webview-safe URI for dist/webview/index.css as a string. */
  stylesUri: string;
  /** Per-resolve crypto nonce (src/extension/getNonce.ts). */
  nonce: string;
  /** Webview-resource base URI for resolving relative image paths against the
   *  document's location, or "" for non-file documents (no resolution). Read
   *  in the webview entry (index.ts) and exposed to imageBlockField via the
   *  quollResourceBaseUri facet. */
  resourceBaseUri: string;
};

const NONCE_RE = /^[A-Za-z0-9+/=_-]+$/;

// webview.cspSource is a space-separated CSP source list, not a single URL —
// the real VS Code value is `'self' https://*.vscode-cdn.net`, so spaces and
// quoted keywords must be accepted (a single-token regex here shipped a
// regression that rejected every real cspSource and blanked the editor).
// Validate per token: either a quoted keyword ('self') or a source expression
// free of the characters that could break out of the CSP directive (`;`),
// the hosting meta attribute (`"`, `<`, `>`), or be smuggled through the
// HTML parser via numeric character references (`&` — e.g. `&#59` decodes
// to `;` before the CSP parser sees the meta content). Stray quotes are
// rejected too.
const CSP_KEYWORD_RE = /^'[A-Za-z0-9-]+'$/;
const CSP_SOURCE_TOKEN_RE = /^[^;"'<>&\s]+$/;

export function buildWebviewHtml(input: BuildWebviewHtmlInput): string {
  const { cspSource, scriptUri, stylesUri, nonce, resourceBaseUri } = input;
  if (!nonce || !NONCE_RE.test(nonce)) {
    throw new Error(`buildWebviewHtml: invalid nonce (must match ${NONCE_RE})`);
  }
  const cspTokens = cspSource.split(/\s+/).filter((token) => token.length > 0);
  if (
    cspTokens.length === 0 ||
    !cspTokens.every((token) => CSP_KEYWORD_RE.test(token) || CSP_SOURCE_TOKEN_RE.test(token))
  ) {
    throw new Error("buildWebviewHtml: cspSource contains disallowed character or is empty");
  }
  // scriptUri / stylesUri are interpolated into the `src` / `href` attribute
  // values of the <script> and <link> tags, so they get the same breakout gate
  // as resourceBaseUri and the cspSource per-token regex — INCLUDING `&`, an
  // HTML entity-injection vector in an attribute value (`&#34` decodes to `"`
  // even without the trailing `;`). asWebviewUri percent-encodes its path, so
  // `&` never appears legitimately → fail-closed with no loss.
  for (const [key, value] of [
    ["scriptUri", scriptUri],
    ["stylesUri", stylesUri],
  ] as const) {
    if (!value || /[;"'<>&\s]/.test(value)) {
      throw new Error(`buildWebviewHtml: ${key} contains disallowed character or is empty`);
    }
  }
  // resourceBaseUri is optional-by-emptiness: "" means "no base" (non-file doc)
  // and emits no attribute. A non-empty value is interpolated into the #root
  // attribute, so it gets the same breakout-character gate as scriptUri PLUS
  // `&` (an HTML entity-injection vector in an attribute value — same reason
  // CSP_SOURCE_TOKEN_RE rejects it). asWebviewUri percent-encodes its path, so
  // `&` never appears legitimately → fail-closed with no loss.
  if (resourceBaseUri !== "" && /[;"'<>&\s]/.test(resourceBaseUri)) {
    throw new Error("buildWebviewHtml: resourceBaseUri contains disallowed character");
  }
  // CSP rationale, per-directive:
  //   default-src 'none'         — default-deny: anything not allowlisted is blocked.
  //   style-src ${cspSource} 'nonce-${nonce}'
  //                              — extension-bundled CSS (<link>) AND nonced
  //     <style> elements only. The nonce admits ONLY <style> elements carrying
  //     THIS resolve's nonce — it is NOT 'unsafe-inline': no source-controlled
  //     inline style is admitted, only ones our own EditorView stamps via
  //     EditorView.cspNonce (src/webview/editor.ts, review fix #34). CodeMirror injects
  //     quollTheme + quollHighlighting as <style> elements into document.head
  //     (cm/theme.ts) and there is no supported way to redirect those into our
  //     bundled <link> sheet — EditorView.cspNonce is CM's sanctioned mechanism.
  //     ⚠ This deliberately reverses ONE assertion of the "CSP phase 3"
  //     hardening (LEARNING 2026-06-10 entry "CSP hardening phase 3 —
  //     `style-src-attr` 完全削除"), which had pinned style-src = cspSource
  //     only, NO nonce. The reversal is the minimum needed to unblock the
  //     CodeMirror migration (C1). All other phase-3 invariants are KEPT:
  //     no 'unsafe-inline', no style-src-attr, no style-src-elem.
  //     The CM table widget aligns cells via CSSOM `element.style.textAlign`
  //     (a DOM property write, not a `style="..."` attribute), so
  //     style-src-attr stays absent. Record this re-introduction in
  //     LEARNING ("Security / Supply chain") under C1.
  //   script-src 'nonce-${nonce}' — only the single nonced bundle.
  //   img-src ${cspSource}       — webview-resolved local resources only.
  //     webview.cspSource authorizes asWebviewUri() outputs (VS Code's own
  //     docs use `img-src ${webview.cspSource}`), so relative images resolved
  //     against the document folder load WITHOUT widening this directive.
  //     CSP is necessary but NOT sufficient: a relative image also needs the
  //     resolved URI to be origin- and directory-trusted
  //     (resolveTrustedResourceUrl checks scheme + authority + document-dir
  //     path containment) AND to
  //     sit inside a localResourceRoots entry (the document folder, widened in
  //     QuollEditorPanel). Arbitrary remote origins are NOT in cspSource, so
  //     remote images (http(s) hosts) stay CSP-blocked — no `data:`, no `https:` *.
  //   font-src ${cspSource}      — webview-bundled fonts only.
  //   connect-src 'none'         — no fetch/XHR/WebSocket; the webview talks
  //     to the host via postMessage exclusively.
  //   base-uri 'none'            — no <base> element may re-point relative URL
  //     resolution (base-uri does NOT fall back to default-src, so it must be
  //     declared explicitly). Defense in depth: script injection is already
  //     nonce-gated, but an injected <base> would silently redirect every
  //     relative fetch the document makes.
  //   form-action 'none'         — no form submission targets (also exempt
  //     from the default-src fallback). The webview renders no forms; a
  //     smuggled <form action> could otherwise exfiltrate without script.
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${cspSource}`,
    `font-src ${cspSource}`,
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" type="text/css" href="${stylesUri}">
    <title>Quoll</title>
  </head>
  <body>
    <div id="root" data-nonce="${nonce}"${
      resourceBaseUri ? ` data-resource-base-uri="${resourceBaseUri}"` : ""
    }></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}
