import { describe, expect, it } from "vitest";

import { buildWebviewHtml } from "../../src/extension/webview-html.js";

describe("buildWebviewHtml", () => {
  // Minimal input shape — every value comes from
  // QuollEditorPanel.resolveCustomTextEditor:
  //   - cspSource is webview.cspSource — the REAL value VS Code provides
  //     (`'self' https://*.vscode-cdn.net`): a space-separated source list
  //     containing a quoted keyword and a wildcard host. A sanitized
  //     single-token fixture previously hid a validation regression that
  //     rejected the real value and broke the editor at runtime
  //     (LEARNING 2026-06-10 cspSource entry).
  //   - scriptUri / stylesUri come from buildWebviewAssetUris
  //   - nonce is the per-resolve crypto nonce
  const fixture = {
    cspSource: "'self' https://*.vscode-cdn.net",
    scriptUri: "https://example-cspsource/dist/webview/index.js",
    stylesUri: "https://example-cspsource/dist/webview/index.css",
    nonce: "abc123def456",
    resourceBaseUri: "",
  };

  it("declares default-src 'none' (default-deny)", () => {
    expect(buildWebviewHtml(fixture)).toMatch(/default-src\s+'none'/);
  });

  it("declares connect-src 'none' (no network)", () => {
    expect(buildWebviewHtml(fixture)).toMatch(/connect-src\s+'none'/);
  });

  it("constrains style-src to cspSource + this resolve's nonce, with no unsafe-inline / hash bypass and no style-src-attr or style-src-elem", () => {
    // C1 reverses ONE assertion of the prior phase-3 tightening (LEARNING
    // 2026-06-10 entry "CSP hardening phase 3 — `style-src-attr` 完全削除")
    // — the nonce is now ADMITTED on style-src so CodeMirror's injected
    // <style> elements (stamped via EditorView.cspNonce) pass the CSP. The
    // OTHER phase-3 invariants are KEPT: no 'unsafe-inline', no hashed
    // inline styles, no style-src-attr, no style-src-elem. The CM table
    // widget aligns cells via CSSOM `element.style.textAlign` (a DOM
    // property write, not a style attribute), so style-src-attr stays absent.
    //
    // Revert-check (manual): temporarily drop the `'nonce-...'` from
    // style-src in buildWebviewHtml → this test goes red on the
    // toContain("'nonce-abc123def456'") assertion (proves the nonce is
    // actually emitted, not vacuously asserted).
    const html = buildWebviewHtml(fixture);
    // \bstyle-src\b prevents the regex from sliding onto `style-src-attr` /
    // `style-src-elem` if a future regression reorders the directive array.
    const styleSrcMatch = /\bstyle-src\b\s+([^;]+)/.exec(html);
    expect(styleSrcMatch).not.toBeNull();
    const styleSrcDirective = styleSrcMatch?.[1].trim();
    expect(styleSrcDirective).toBe("'self' https://*.vscode-cdn.net 'nonce-abc123def456'");
    expect(styleSrcDirective).toContain("'self' https://*.vscode-cdn.net");
    expect(styleSrcDirective).toContain("'nonce-abc123def456'");
    expect(styleSrcDirective).not.toMatch(/unsafe-inline/);
    expect(styleSrcDirective).not.toMatch(/'sha\d+-/);
    expect(html).not.toMatch(/style-src-attr/);
    expect(html).not.toMatch(/style-src-elem/);
  });

  it("admits no 'unsafe-inline' anywhere in the policy (editor styling never emits a parsed style= attribute)", () => {
    // Residual audit for the C4a-C7 decoration/widget slices (TODO 7B CSP
    // follow-up). What's certain and load-bearing: Quoll's editor styling never
    // emits a parsed `style=` HTML attribute and never calls
    // `setAttribute("style", …)`, so the inline-style-attribute path that
    // 'unsafe-inline' / style-src-attr authorise is never exercised. Styling
    // rides three other paths:
    //   - individual CSSOM PROPERTY writes, e.g. table-widget.ts
    //     `el.style.textAlign = v` — NOT subject to style-src at all
    //     (MDN: CSP style-src), so cleanly outside the policy;
    //   - CSSOM `cssText` writes — list-hang-indent.ts emits
    //     `Decoration.line({ attributes: { style } })`, which CM's `updateAttrs`
    //     applies via `dom.style.cssText = value` (NOT `setAttribute("style")` —
    //     verified in @codemirror/view dist); prose-space-metric.ts similarly
    //     writes `probe.style.cssText`;
    //   - nonce-stamped `<style>` (CM theme via EditorView.cspNonce) + the
    //     bundled `<link>` sheet — both covered by `style-src cspSource + nonce`.
    // ⚠️ The exact CSP treatment of CSSOM `cssText` writes is contested between
    // MDN sources: the style-src page puts it under 'unsafe-eval' (CSSOM-method
    // provision; spec-level, unenforced); the style-src-attr page lists cssText
    // as a violation case for style-src-attr, where the permitting token would
    // be 'unsafe-inline'. Both pages agree no current browser enforces any gate
    // on CSSOM writes, so they apply today (feature dogfooded working). The
    // policy grants NONE of the candidate tokens (no 'unsafe-inline', no
    // 'unsafe-eval', no style-src-attr), so the forward residual risk is real:
    // a future browser that begins enforcing a cssText gate — under whichever
    // directive — could block these styles. Full analysis in LEARNING.md
    // (review cycle, PR #164). The assertion below pins that we have not added
    // 'unsafe-inline'. Regression guard for "a future widget that emits a real
    // style= attribute forces 'unsafe-inline' in": that flips this red.
    // Revert-check (manual): add 'unsafe-inline' to any directive in
    // buildWebviewHtml -> this assertion goes red (proves non-vacuous).
    expect(buildWebviewHtml(fixture)).not.toMatch(/unsafe-inline/);
  });

  it("binds script-src to the nonce only — no extra sources past the nonce token", () => {
    const html = buildWebviewHtml(fixture);
    // Symmetric with default-src / connect-src below: stop the capture at the
    // next directive separator (`;`) OR the meta tag's closing quote (`"`),
    // so the regex stays robust when the directive is the last entry in the
    // CSP string (no trailing `;`). script-src is the highest-stakes
    // directive — a `[^;]+` bound would swallow the rest of the HTML on a
    // reorder and produce a misleading "script-src widened" failure pointing
    // reviewers at the wrong root cause.
    const scriptSrcMatch = /\bscript-src\b\s+([^;"]+)/.exec(html);
    expect(scriptSrcMatch).not.toBeNull();
    const scriptSrcDirective = scriptSrcMatch?.[1].trim();
    expect(scriptSrcDirective).toBe("'nonce-abc123def456'");
    expect(html).not.toMatch(/unsafe-eval/);
    expect(html).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it("default-src is exactly 'none' (no implicit widening)", () => {
    const html = buildWebviewHtml(fixture);
    // Stop the capture at the next directive separator (`;`) OR the
    // meta tag's closing quote (`"`), so the regex stays robust when the
    // directive is the last entry in the CSP string (no trailing `;`).
    const match = /\bdefault-src\b\s+([^;"]+)/.exec(html);
    expect(match?.[1].trim()).toBe("'none'");
  });

  it("connect-src is exactly 'none' (no postMessage-bypass network channel)", () => {
    const html = buildWebviewHtml(fixture);
    // connect-src is currently the last directive emitted; the trailing
    // bound must include `"` so the capture stops at the meta tag close
    // rather than swallowing the rest of the HTML.
    const match = /\bconnect-src\b\s+([^;"]+)/.exec(html);
    expect(match?.[1].trim()).toBe("'none'");
  });

  it("constrains img-src to the webview's cspSource only (no remote images)", () => {
    const html = buildWebviewHtml(fixture);
    // Exact equality with cspSource pins "no widening beyond what VS Code
    // grants". (A blanket "no `*` in img-src" assertion is no longer viable:
    // the real cspSource itself carries a subdomain wildcard,
    // https://*.vscode-cdn.net, which VS Code resolves to its own CDN origin.)
    const imgSrcMatch = /\bimg-src\b\s+([^;"]+)/.exec(html);
    expect(imgSrcMatch?.[1].trim()).toBe("'self' https://*.vscode-cdn.net");
  });

  it("constrains font-src to the webview's cspSource only", () => {
    const html = buildWebviewHtml(fixture);
    const fontSrcMatch = /\bfont-src\b\s+([^;"]+)/.exec(html);
    expect(fontSrcMatch?.[1].trim()).toBe("'self' https://*.vscode-cdn.net");
  });

  it("binds the script tag to the correct dist/webview path with the nonce", () => {
    expect(buildWebviewHtml(fixture)).toMatch(
      /<script\s+type="module"\s+nonce="abc123def456"\s+src="https:\/\/example-cspsource\/dist\/webview\/index\.js"/
    );
  });

  it("links the styles from dist/webview/index.css", () => {
    expect(buildWebviewHtml(fixture)).toMatch(
      /<link\s+rel="stylesheet"[^>]*href="https:\/\/example-cspsource\/dist\/webview\/index\.css"/
    );
  });

  it("includes the #root mount node with the CSP nonce stamped as data-nonce", () => {
    // The webview entry (src/webview/index.tsx) reads this data attribute
    // and threads it through App → Editor → EditorView.cspNonce so
    // CodeMirror's injected <style> elements carry the nonce admitted by
    // style-src. The nonce is the same per-resolve value
    // already validated against NONCE_RE at the top of buildWebviewHtml,
    // so injecting it into a data attribute is safe.
    expect(buildWebviewHtml(fixture)).toMatch(/<div\s+id="root"\s+data-nonce="abc123def456">/);
  });

  it("throws when nonce contains a disallowed character (semicolon)", () => {
    expect(() => buildWebviewHtml({ ...fixture, nonce: "abc;def" })).toThrow(
      /buildWebviewHtml: invalid nonce/
    );
  });

  it("throws when nonce is empty", () => {
    expect(() => buildWebviewHtml({ ...fixture, nonce: "" })).toThrow(
      /buildWebviewHtml: invalid nonce/
    );
  });

  it("throws when cspSource contains a quote (CSP injection vector)", () => {
    expect(() => buildWebviewHtml({ ...fixture, cspSource: 'https://example"-injection' })).toThrow(
      /buildWebviewHtml: cspSource contains disallowed character/
    );
  });

  it("throws when cspSource contains a stray single quote inside a source-expression token", () => {
    // Quoted keyword tokens like 'self' / 'unsafe-inline' ARE accepted
    // (CSP_KEYWORD_RE in webview-html.ts) — see the default fixture above.
    // What's rejected here is a single quote embedded inside a
    // non-keyword token (`https://example'-injection`): it matches
    // neither the keyword pattern nor the source-expression pattern, so
    // the validator throws. This pins the boundary between legitimate
    // keyword syntax and an injection attempt.
    expect(() => buildWebviewHtml({ ...fixture, cspSource: "https://example'-injection" })).toThrow(
      /buildWebviewHtml: cspSource contains disallowed character/
    );
  });

  it("throws when cspSource contains an angle bracket (tag breakout vector)", () => {
    expect(() => buildWebviewHtml({ ...fixture, cspSource: "https://example</script>" })).toThrow(
      /buildWebviewHtml: cspSource contains disallowed character/
    );
    expect(() => buildWebviewHtml({ ...fixture, cspSource: "https://example>x" })).toThrow(
      /buildWebviewHtml: cspSource contains disallowed character/
    );
  });

  it("throws when cspSource contains a semicolon (directive injection vector)", () => {
    expect(() =>
      buildWebviewHtml({ ...fixture, cspSource: "'self'; script-src 'unsafe-eval'" })
    ).toThrow(/buildWebviewHtml: cspSource contains disallowed character/);
  });

  it("throws when cspSource contains an ampersand (HTML entity injection vector)", () => {
    // The validated cspSource is interpolated directly into the
    // <meta http-equiv="Content-Security-Policy" content="..."> attribute
    // (see webview-html.ts buildWebviewHtml return). HTML parsers decode
    // numeric character references (including legacy `&#NN` without a
    // terminating `;`) before the CSP parser sees the string, so a token
    // like `https://safe.example&#59script-src&#32*` would decode to
    // `https://safe.example;script-src *`, injecting an extra `script-src`
    // directive past the nonce-only constraint. The per-token regex must
    // reject `&` to close this breakout.
    expect(() =>
      buildWebviewHtml({ ...fixture, cspSource: "https://safe.example&#59script-src&#32*" })
    ).toThrow(/buildWebviewHtml: cspSource contains disallowed character/);
  });

  it("throws when cspSource is empty", () => {
    expect(() => buildWebviewHtml({ ...fixture, cspSource: "" })).toThrow(
      /buildWebviewHtml: cspSource contains disallowed character or is empty/
    );
  });

  it("throws when cspSource is whitespace only", () => {
    expect(() => buildWebviewHtml({ ...fixture, cspSource: "   " })).toThrow(
      /buildWebviewHtml: cspSource contains disallowed character or is empty/
    );
  });

  it("throws when scriptUri contains whitespace", () => {
    expect(() => buildWebviewHtml({ ...fixture, scriptUri: "https://x y/" })).toThrow(
      /buildWebviewHtml: scriptUri contains disallowed character/
    );
  });

  it("throws when stylesUri contains a disallowed character (semicolon)", () => {
    // The strict-URI validation loop in src/extension/webview-html.ts
    // iterates two keys: scriptUri and stylesUri (cspSource has its own
    // per-token validator above the loop). Without this test only the
    // scriptUri arm is pinned — a regression that dropped the
    // ["stylesUri", stylesUri] tuple would be silent.
    expect(() => buildWebviewHtml({ ...fixture, stylesUri: "https://x;y/" })).toThrow(
      /buildWebviewHtml: stylesUri contains disallowed character/
    );
  });

  it("omits data-resource-base-uri on #root when resourceBaseUri is empty (non-file document)", () => {
    expect(buildWebviewHtml(fixture)).not.toMatch(/data-resource-base-uri/);
  });

  it("emits data-resource-base-uri on #root when a base URI is provided", () => {
    // Literal `+` is the real asWebviewUri host shape; it passes the
    // /[;"'<>&\s]/ gate (no rejected char) and is emitted verbatim.
    const html = buildWebviewHtml({
      ...fixture,
      resourceBaseUri: "https://file+.vscode-resource.vscode-cdn.net/ws/notes/a.md",
    });
    expect(html).toMatch(
      /<div\s+id="root"\s+data-nonce="abc123def456"\s+data-resource-base-uri="https:\/\/file\+\.vscode-resource\.vscode-cdn\.net\/ws\/notes\/a\.md">/
    );
  });

  it("throws when resourceBaseUri contains a disallowed character (quote)", () => {
    expect(() => buildWebviewHtml({ ...fixture, resourceBaseUri: 'https://x"y' })).toThrow(
      /buildWebviewHtml: resourceBaseUri contains disallowed character/
    );
  });

  it("throws when resourceBaseUri contains whitespace", () => {
    expect(() => buildWebviewHtml({ ...fixture, resourceBaseUri: "https://x y" })).toThrow(
      /buildWebviewHtml: resourceBaseUri contains disallowed character/
    );
  });

  it("throws when resourceBaseUri contains an ampersand (HTML entity injection vector)", () => {
    // The value is interpolated into the data-resource-base-uri attribute.
    // A raw `&` could begin a numeric character reference (e.g. `&#34` →
    // `"`) that the HTML parser decodes before the attribute boundary,
    // breaking out of the attribute. asWebviewUri percent-encodes its path
    // (no raw `&`), so rejecting `&` is fail-closed with no legitimate loss —
    // symmetric with the cspSource per-token gate (CSP_SOURCE_TOKEN_RE).
    expect(() => buildWebviewHtml({ ...fixture, resourceBaseUri: "https://x&#34y" })).toThrow(
      /buildWebviewHtml: resourceBaseUri contains disallowed character/
    );
  });
});
