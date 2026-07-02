// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { CellLeaf } from "../../src/webview/cm/table/cell-render.js";
import { parseCellInline, renderCellInline } from "../../src/webview/cm/table/cell-render.js";
import type { Resolved, Span } from "../../src/webview/cm/table/inline-emphasis.js";

function html(nodes: Node[]): string {
  const root = document.createElement("div");
  for (const n of nodes) {
    root.appendChild(n);
  }
  return root.innerHTML;
}

describe("renderCellInline", () => {
  it("renders plain text as a single text node", () => {
    const nodes = renderCellInline("hello");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(nodes[0].textContent).toBe("hello");
  });

  it("returns an empty array for an empty string", () => {
    expect(renderCellInline("")).toEqual([]);
  });

  it("renders an inline link [text](url) as <a href> when URL is allowed", () => {
    const nodes = renderCellInline("see [docs](https://example.com)");
    // Strip `title="…"` before comparing — the discoverability tooltip
    // resolves "Cmd" vs "Ctrl" at module load via `navigator.platform`,
    // so pinning it inline makes the snapshot platform-dependent. The
    // dedicated tooltip test below uses an environment-safe regex; the
    // structural snapshot should be platform-agnostic.
    expect(html(nodes).replace(/ title="[^"]*"/g, "")).toBe(
      'see <a href="https://example.com" rel="noopener noreferrer">docs</a>'
    );
  });

  it("renders an unsafe inline link as inert text", () => {
    const nodes = renderCellInline("[bad](javascript:alert(1))");
    expect(html(nodes)).toBe("[bad](javascript:alert(1))");
  });

  // CommonMark backslash + HTML-entity bypass. Without decoding the
  // destination before the allowlist gate, `javascript&#58;…`
  // and `javascript\:…` look schemeless to the regex in `isAllowedUrl`,
  // get classified as "relative", and ship as a live `<a href>` that the
  // browser then resolves to `javascript:…` → XSS.
  it("blocks `[bad](javascript&#58;alert(1))` (HTML-entity scheme bypass)", () => {
    const nodes = renderCellInline("[bad](javascript&#58;alert(1))");
    expect(html(nodes)).toBe("[bad](javascript&amp;#58;alert(1))");
  });

  it("blocks `[bad](javascript\\:alert(1))` (backslash-escape scheme bypass)", () => {
    const nodes = renderCellInline("[bad](javascript\\:alert(1))");
    expect(html(nodes)).toBe("[bad](javascript\\:alert(1))");
  });

  it("blocks `[bad](javascript&colon;alert(1))` (named-entity scheme bypass)", () => {
    const nodes = renderCellInline("[bad](javascript&colon;alert(1))");
    expect(html(nodes)).toBe("[bad](javascript&amp;colon;alert(1))");
  });

  it("renders an inline image ![alt](url) as <img src> with alt", () => {
    const nodes = renderCellInline("![logo](https://x.test/a.png)");
    expect(html(nodes)).toBe('<img src="https://x.test/a.png" alt="logo">');
  });

  it("CommonMark-normalizes an image alt (![*em*](url) -> alt=em)", () => {
    const nodes = renderCellInline("![*em*](https://x.test/a.png)");
    expect(html(nodes)).toBe('<img src="https://x.test/a.png" alt="em">');
  });

  it("decodes an entity in an image alt (![a&amp;b](url) -> alt=a&b)", () => {
    const nodes = renderCellInline("![a&amp;b](https://x.test/a.png)");
    // innerHTML re-encodes & in the attribute, so assert via the DOM node.
    expect((nodes[0] as HTMLImageElement).alt).toBe("a&b");
  });

  it("renders an unsafe inline image as inert text", () => {
    const nodes = renderCellInline("![x](javascript:1)");
    expect(html(nodes)).toBe("![x](javascript:1)");
  });

  it("blocks `![x](javascript&#58;1)` image (HTML-entity scheme bypass)", () => {
    const nodes = renderCellInline("![x](javascript&#58;1)");
    expect(html(nodes)).toBe("![x](javascript&amp;#58;1)");
  });

  // ── Consolidated table-cell URL-gate semantics (shared decode→gate) ─────────
  // After routing through the shared renderSafeMarkdownDestination, these inputs
  // are gated identically to the block-image widget + the host write-gate. The
  // first four were LIVE <a>/<img> under the old local decoder (which left the
  // encoded form literal / required a trailing `;` / was case-sensitive); the
  // shared canonical decoder resolves or NUL-substitutes them → blocked.
  it("blocks `[bad](javascript&unknownentity;:1)` (unknown-entity bypass → NUL)", () => {
    expect(html(renderCellInline("[bad](javascript&unknownentity;:1)"))).toBe(
      "[bad](javascript&amp;unknownentity;:1)"
    );
  });

  it("blocks `[bad](javascript&#58alert(1))` (semicolonless numeric ref decodes to `:`)", () => {
    expect(html(renderCellInline("[bad](javascript&#58alert(1))"))).toBe(
      "[bad](javascript&amp;#58alert(1))"
    );
  });

  it("blocks `[bad](javascript&COLON;alert(1))` (uppercase named ref, case-insensitive)", () => {
    expect(html(renderCellInline("[bad](javascript&COLON;alert(1))"))).toBe(
      "[bad](javascript&amp;COLON;alert(1))"
    );
  });

  it("blocks `[bad](java&tab;script:1)` (control entity decodes to TAB → C0 reject)", () => {
    expect(html(renderCellInline("[bad](java&tab;script:1)"))).toBe("[bad](java&amp;tab;script:1)");
  });

  // Benign URLs still render live — the named-entity arm requires a trailing `;`,
  // so plain query params survive, and `&amp;` decodes to `&` and stays safe.
  it("keeps a plain multi-param query link live (`[x](https://x.test/?a=1&b=2)`)", () => {
    expect(
      html(renderCellInline("[x](https://x.test/?a=1&b=2)")).replace(/ title="[^"]*"/g, "")
    ).toBe('<a href="https://x.test/?a=1&amp;b=2" rel="noopener noreferrer">x</a>');
  });

  it("keeps a `&amp;`-bearing query link live (`[x](https://x.test/?q=a&amp;b)`)", () => {
    expect(
      html(renderCellInline("[x](https://x.test/?q=a&amp;b)")).replace(/ title="[^"]*"/g, "")
    ).toBe('<a href="https://x.test/?q=a&amp;b" rel="noopener noreferrer">x</a>');
  });

  // OVER-BLOCK POLICY (Codex Conf 95): a safe-scheme URL carrying a non-curated
  // semicolon-terminated named entity (`&copy;`) is undecodable → NUL → blocked.
  // This was a LIVE link under the old local decoder; the consolidation makes
  // table-cell render match the write-gate (non-persistable) + block-image gate.
  it("blocks `[x](https://x.test/?q=a&copy;b)` (non-curated entity over-block policy)", () => {
    expect(html(renderCellInline("[x](https://x.test/?q=a&copy;b)"))).toBe(
      "[x](https://x.test/?q=a&amp;copy;b)"
    );
  });

  it("renders an autolink <https://…> as <a href> when allowed", () => {
    const nodes = renderCellInline("see <https://example.com>");
    expect(html(nodes).replace(/ title="[^"]*"/g, "")).toBe(
      'see <a href="https://example.com" rel="noopener noreferrer">https://example.com</a>'
    );
  });

  it("leaves an unsafe autolink as inert text", () => {
    const nodes = renderCellInline("<javascript:alert(1)>");
    expect(html(nodes)).toBe("&lt;javascript:alert(1)&gt;");
  });

  it("renders inline `code` as <code>", () => {
    const nodes = renderCellInline("use `git diff`");
    expect(html(nodes)).toBe("use <code>git diff</code>");
  });

  // CommonMark §6.1: a multi-backtick opener with no matching closing run
  // renders literally. The C6b scope is single-backtick spans only; the
  // pre-fix code greedily paired the first two backticks of `` `` `` and
  // emitted an empty `<code></code>`. Multi-backtick code spans + CommonMark
  // code normalization are deferred out of C6c scope — multi-backtick runs
  // fall through to literal text indefinitely until that scope lands.
  it("renders a double-backtick `` `` `` sequence as literal text (no empty <code>)", () => {
    expect(html(renderCellInline("``"))).toBe("``");
    expect(html(renderCellInline("a `` b"))).toBe("a `` b");
  });

  it("decodes escaped pipe `\\|` to a literal `|` in text", () => {
    const nodes = renderCellInline("a\\|b");
    expect(html(nodes)).toBe("a|b");
  });

  it("HTML-escapes raw `<` / `>` / `&` in plain text", () => {
    const nodes = renderCellInline("a < b & c > d");
    expect(html(nodes)).toBe("a &lt; b &amp; c &gt; d");
  });

  // Basic paired emphasis renders live. (Full CommonMark §6.4 — nesting,
  // `_underscore_`, and delimiter-run flanking — is pinned by the dedicated
  // cases further down.) The C4a orchestrator's reveal spans are still dropped
  // because the table's range is in the exclusion facet.
  it("renders `**bold**` as a live <strong>", () => {
    expect(html(renderCellInline("**bold**"))).toBe("<strong>bold</strong>");
  });

  it("renders `*em*` as a live <em>", () => {
    expect(html(renderCellInline("*em*"))).toBe("<em>em</em>");
  });

  // The inner walk runs with emphasis disabled, but link / image / autolink /
  // code parsing — and therefore the URL-safety gate — still apply. An
  // unsafe URL inside emphasis MUST still be rendered inert (no live `<a>`).
  it("routes an unsafe URL inside emphasis through renderSafeUrl (`**[bad](javascript:1)**`)", () => {
    expect(html(renderCellInline("**[bad](javascript:1)**"))).toBe(
      "<strong>[bad](javascript:1)</strong>"
    );
  });

  it("leaves unpaired emphasis delimiters as literal text", () => {
    expect(html(renderCellInline("**unclosed"))).toBe("**unclosed");
    expect(html(renderCellInline("*also unclosed"))).toBe("*also unclosed");
  });

  // Full delimiter stack: a `**` opener with only a single `*` closer consumes
  // one delimiter from each, leaving one literal `*` before a live <em>.
  // Verified via @lezer/markdown.
  it("renders `**a*` as `*<em>a</em>` (leftover opener delimiter)", () => {
    expect(html(renderCellInline("**a*"))).toBe("*<em>a</em>");
  });

  // Task #2: positive pin that a safe link inside emphasis renders correctly.
  // Strip the platform-specific `title` (Cmd vs Ctrl) so the assertion stays
  // environment-agnostic — the title contract is pinned in its own test.
  it("renders a safe link inside emphasis (`*[ok](https://x.test)*`)", () => {
    expect(html(renderCellInline("*[ok](https://x.test)*")).replace(/ title="[^"]*"/g, "")).toBe(
      '<em><a href="https://x.test" rel="noopener noreferrer">ok</a></em>'
    );
  });

  // Task #3: empty-emphasis boundary — `****` must not produce an empty
  // `<strong></strong>` (the `close > i + 2` guard rejects a close that is
  // immediately adjacent to the opener, e.g. `****` where close == i + 2).
  it("renders `****` as literal text (empty strong prevented by close > i + 2 guard)", () => {
    expect(html(renderCellInline("****"))).toBe("****");
  });

  it("renders bare `**` as literal text (no close)", () => {
    expect(html(renderCellInline("**"))).toBe("**");
  });

  // Task #5: CommonMark §6.2 flanking rule — whitespace immediately after
  // the opener or before the closer disqualifies the delimiter run.
  it("renders `* em *` as literal text (opener-after-whitespace, CommonMark flanking rule)", () => {
    expect(html(renderCellInline("* em *"))).toBe("* em *");
  });

  it("renders `**bold **` as literal text (closer-before-whitespace, CommonMark flanking rule)", () => {
    expect(html(renderCellInline("**bold **"))).toBe("**bold **");
  });

  // Task #6: CommonMark §6.1 backslash escape for `*` suppresses emphasis.
  it("renders `\\*not em\\*` as literal `*not em*` (backslash escape suppresses em)", () => {
    expect(html(renderCellInline("\\*not em\\*"))).toBe("*not em*");
  });

  // Full CommonMark §6.1/§6.4: `\*` escapes the first `*` of each pair, leaving
  // the second `*` as a live delimiter. The trailing `\*` is an escaped literal
  // `*` INSIDE the span; the final bare `*` closes it. Verified via @lezer/markdown.
  it("renders `\\**not strong\\**` as `*<em>not strong*</em>` (CommonMark escape + flanking)", () => {
    expect(html(renderCellInline("\\**not strong\\**"))).toBe("*<em>not strong*</em>");
  });

  // CommonMark §6.1 backslash parity: `\\` is itself an escape sequence
  // (literal `\`), so `\\*em*` MUST parse as literal `\` followed by a live
  // `<em>em</em>`. Without the `\\` guard, the second `\` would mis-fire as
  // the start of `\*` and silently suppress the emphasis.
  it("renders `\\\\*em*` as literal `\\` plus live <em> (backslash parity)", () => {
    expect(html(renderCellInline("\\\\*em*"))).toBe("\\<em>em</em>");
  });

  it("renders `\\\\**bold**` as literal `\\` plus live <strong>", () => {
    expect(html(renderCellInline("\\\\**bold**"))).toBe("\\<strong>bold</strong>");
  });

  // Full delimiter stack now nests: outer `**` strong contains an inner `*` em.
  // Verified via @lezer/markdown.
  it("nests inner emphasis inside outer emphasis (`**a *b* c**`)", () => {
    expect(html(renderCellInline("**a *b* c**"))).toBe("<strong>a <em>b</em> c</strong>");
  });

  // --- C6c: full CommonMark §6.4 delimiter-stack cases (all verified via
  // @lezer/markdown). ---

  it("keeps the inner `**` literal in `*a**b*` (rule of 3)", () => {
    expect(html(renderCellInline("*a**b*"))).toBe("<em>a**b</em>");
  });

  it("renders `**a ** b**` as `<strong>a ** b</strong>` (whitespace-flanked inner `**` is literal)", () => {
    expect(html(renderCellInline("**a ** b**"))).toBe("<strong>a ** b</strong>");
  });

  it("splits `***text***` into nested `<em><strong>`", () => {
    expect(html(renderCellInline("***text***"))).toBe("<em><strong>text</strong></em>");
  });

  it("renders `_x_` as live <em> (underscore emphasis)", () => {
    expect(html(renderCellInline("_x_"))).toBe("<em>x</em>");
  });

  it("renders `__b__` as live <strong> (underscore strong)", () => {
    expect(html(renderCellInline("__b__"))).toBe("<strong>b</strong>");
  });

  it("leaves intraword underscores literal (`a_b_c`, `foo_bar_baz`)", () => {
    expect(html(renderCellInline("a_b_c"))).toBe("a_b_c");
    expect(html(renderCellInline("foo_bar_baz"))).toBe("foo_bar_baz");
  });

  it("renders an escaped delimiter inside emphasis literally (`*a\\*b*`)", () => {
    expect(html(renderCellInline("*a\\*b*"))).toBe("<em>a*b</em>");
  });

  // 6-state openers_bottom regression: a closer that can also open must not
  // poison a later close-only closer's opener bound. A 3-state bound yields
  // `**a<em>a</em>a*`. Verified via @lezer/markdown.
  it("nests `**a*a*a*` as `*<em>a<em>a</em>a</em>` (6-state openers_bottom)", () => {
    expect(html(renderCellInline("**a*a*a*"))).toBe("*<em>a<em>a</em>a</em>");
  });

  // Unicode flanking: `©` is a Symbol (Unicode S), which CommonMark counts as a
  // punctuation character. With `©` before the second `*`, that run is not
  // right-flanking, so it cannot close → the whole thing stays literal. (A
  // `\p{P}`-only classifier would wrongly emit `a<em>b©</em>c`.) Verified via
  // @lezer/markdown.
  it("treats a Unicode symbol as punctuation for flanking (`a*b©*c` stays literal)", () => {
    expect(html(renderCellInline("a*b©*c"))).toBe("a*b©*c");
  });

  // Deferred (C6c-proper, not a regression): emphasis inside a link label is
  // NOT parsed — the label renders as plain text. Links bind tighter than
  // emphasis and the tokenizer resolves them atomically. Pins the boundary so
  // the deferral is intentional. CommonMark would emit `<a>a <em>b</em> c</a>`.
  it("does NOT parse emphasis inside a link label (deferred to C6c-proper)", () => {
    expect(html(renderCellInline("[a *b* c](https://x.test)")).replace(/ title="[^"]*"/g, "")).toBe(
      '<a href="https://x.test" rel="noopener noreferrer">a *b* c</a>'
    );
  });

  // Astral-plane flanking — exercises the `charBefore` / `charAfter` whole-code-
  // point path that the BMP `a*b©*c` case does not. Classification is by Unicode
  // code point category: 💲 (U+1F4B2) is a Symbol (S) → punctuation; 𐀀 (U+10000)
  // is a Letter (Lo) → not punctuation. Expectations follow the CommonMark spec
  // and the reference markdown-it brute-force (Codex review). NOTE: @lezer/markdown
  // is NOT the oracle for these — it classifies astral chars on UTF-16 units and
  // gets them wrong (`a*b💲*c` → `a<em>b💲</em>c`), which is exactly the lone-
  // surrogate hazard that `charBefore`'s pair handling avoids.
  it("treats an astral symbol as punctuation before a closer (`a*b💲*c` literal)", () => {
    expect(html(renderCellInline("a*b💲*c"))).toBe("a*b💲*c");
  });

  it("treats an astral symbol as punctuation after an opener (`a*💲b*c` literal)", () => {
    expect(html(renderCellInline("a*💲b*c"))).toBe("a*💲b*c");
  });

  it("treats an astral letter as non-punctuation (`a*𐀀b*c` → em)", () => {
    expect(html(renderCellInline("a*𐀀b*c"))).toBe("a<em>𐀀b</em>c");
  });

  it("renders mixed content in source order", () => {
    const nodes = renderCellInline("pre [link](https://e.test) mid `code` end");
    expect(html(nodes).replace(/ title="[^"]*"/g, "")).toBe(
      'pre <a href="https://e.test" rel="noopener noreferrer">link</a> mid <code>code</code> end'
    );
  });

  // error-handler re-review Conf 82 — balanced parens in URLs (CommonMark §6.6).
  // Without depth-aware parsing, Wikipedia / MDN URLs containing `(...)` would
  // truncate at the first `)` and ship a broken href.
  it("preserves balanced parens in a URL (CommonMark §6.6)", () => {
    const nodes = renderCellInline(
      "[Rust](https://en.wikipedia.org/wiki/Rust_(programming_language))"
    );
    expect(html(nodes).replace(/ title="[^"]*"/g, "")).toBe(
      '<a href="https://en.wikipedia.org/wiki/Rust_(programming_language)" rel="noopener noreferrer">Rust</a>'
    );
  });

  it("preserves a backslash-escaped `)` inside the URL", () => {
    const nodes = renderCellInline("[x](https://e.test/a\\)b)");
    // The decoded URL is `https://e.test/a)b`. allowlist passes (https scheme).
    expect(html(nodes).replace(/ title="[^"]*"/g, "")).toBe(
      '<a href="https://e.test/a)b" rel="noopener noreferrer">x</a>'
    );
  });

  it("rejects an unescaped `<` or `>` inside the URL (CommonMark §6.3)", () => {
    // `[x](foo<bar)` is not a well-formed link — destination must not contain
    // bare `<` / `>`. Falls back to literal text.
    expect(html(renderCellInline("[x](foo<bar)"))).toBe("[x](foo&lt;bar)");
    expect(html(renderCellInline("[x](foo>bar)"))).toBe("[x](foo&gt;bar)");
  });

  // C6b smoke #5 — plain click on a widget-internal link must NOT navigate to
  // the browser (that bypasses caret-reveal and locks the user out of editing
  // the link source). Modifier-click is the documented escape hatch matching
  // VS Code Markdown preview / Go-to-Definition convention.
  it("inline-link plain click is preventDefault'd (so the widget's caret-dispatch path takes over)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("inline-link Cmd/Ctrl-click falls through to default navigation (no preventDefault)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  // `isAllowedUrl` returns true for any schemeless string
  // (relative paths / fragments fall through to the "safe" branch), so
  // `./doc.md` and `#section` ship as live <a href>. Browser behaviour
  // for modifier-click on a relative href inside the VS Code webview
  // iframe is undefined. Pin modifier-click to preventDefault for
  // non-absolute hrefs so the user lands on the widget's caret-dispatch
  // path instead.
  it("relative-URL modifier-click is preventDefault'd (no undefined webview navigation)", () => {
    const [a] = renderCellInline("[local](./doc.md)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it("fragment-URL modifier-click is preventDefault'd", () => {
    const [a] = renderCellInline("[section](#intro)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  // Pin the positive case so the absolute-scheme allowlist doesn't tighten
  // too far in a future refactor — mailto: must keep the external escape
  // hatch alongside https / http. Iterate both modifiers so a regression
  // that tightens the guard to `metaKey only` (or `ctrlKey only`) trips.
  it("mailto: modifier-click falls through to default navigation (absolute scheme — external open)", () => {
    const [a] = renderCellInline("[mail](mailto:a@b.test)") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("autolink plain click is preventDefault'd (same gate as inline links)", () => {
    const [a] = renderCellInline("<https://example.com>") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  // Autolink positive case — parallel to the inline-link Cmd/Ctrl test above.
  // Pins the autolink branch directly so a refactor that drops `attachLinkClickGuard`
  // from the autolink path trips here.
  it("autolink Cmd/Ctrl-click falls through to default navigation (absolute scheme — external open)", () => {
    const [a] = renderCellInline("<https://example.com>") as HTMLAnchorElement[];
    expect(a).toBeInstanceOf(HTMLAnchorElement);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
  });

  it("emits a discoverability tooltip on links (mentions the modifier key)", () => {
    const [a] = renderCellInline("[docs](https://example.com)") as HTMLAnchorElement[];
    expect(a.title).toMatch(/(Cmd|Ctrl)\+click to open/);
  });

  // Parallel pin for autolinks — the existing snapshot tests strip
  // `title="…"` before comparing (platform-dependent), so a regression
  // that forgot to attach the tooltip to autolinks would slip through.
  it("emits a discoverability tooltip on autolinks (mentions the modifier key)", () => {
    const [a] = renderCellInline("<https://example.com>") as HTMLAnchorElement[];
    expect(a.title).toMatch(/(Cmd|Ctrl)\+click to open/);
  });
});

// ── parseCellInline losslessness ─────────────────────────────────────────────

// Depth-first ordered leaf spans: text spans, leaf outer spans, and for
// emphasis the openDelim span, then children (recursive), then closeDelim.
function leafSpans(ir: Resolved<CellLeaf>[]): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const n of ir) {
    if (n.kind === "emphasis") {
      out.push(n.openDelim, ...leafSpans(n.children), n.closeDelim);
    } else {
      out.push(n.span);
    }
  }
  return out;
}

describe("parseCellInline losslessness", () => {
  const corpus = [
    "hello",
    "",
    "*em*",
    "**b**",
    "***t***",
    "a_b_c",
    "*a**b*",
    "**a*a*a*",
    "x \\| y",
    "`code`",
    "see [docs](https://example.com)",
    "![alt](https://x.test/i.png)",
    "<https://x.test>",
    "[bad](javascript:1)",
    "a*b©*c",
    "pre **a *b* c** post",
  ];
  for (const raw of corpus) {
    it(`partitions ${JSON.stringify(raw)} into ordered leaves that reconstruct the source`, () => {
      const spans = leafSpans(parseCellInline(raw));
      // ordered + contiguous + covering
      let cursor = 0;
      let rebuilt = "";
      for (const s of spans) {
        expect(s.from).toBe(cursor);
        rebuilt += raw.slice(s.from, s.to);
        cursor = s.to;
      }
      expect(cursor).toBe(raw.length);
      expect(rebuilt).toBe(raw);
    });
  }

  it("exposes link boundary spans for dimming", () => {
    const ir = parseCellInline("[docs](https://x.test)");
    const link = ir[0];
    if (link.kind !== "leaf" || link.leaf.kind !== "link") {
      throw new Error("expected link leaf");
    }
    expect(link.leaf.safeUrl).toBe("https://x.test");
    expect("[docs](https://x.test)".slice(link.leaf.label.from, link.leaf.label.to)).toBe("docs");
    expect("[docs](https://x.test)".slice(link.leaf.dest.from, link.leaf.dest.to)).toBe(
      "https://x.test"
    );
  });

  // Per-construct boundary spans must partition each leaf's OUTER span in source
  // order — else PR2 dims the wrong characters while the outer-span partition
  // test above still passes (Codex plan review Conf 98).
  it("each leaf's boundary spans partition its outer span in order", () => {
    const samples: Array<{ raw: string; kind: CellLeaf["kind"] }> = [
      { raw: "a\\|b", kind: "escape" },
      { raw: "`code`", kind: "code" },
      { raw: "see [docs](https://example.com)", kind: "link" },
      { raw: "![alt](https://x.test/i.png)", kind: "image" },
      { raw: "<https://x.test>", kind: "autolink" },
    ];
    for (const { raw, kind } of samples) {
      const leaves = walkLeaves(parseCellInline(raw));
      // Pin that the construct is emitted as the EXPECTED leaf kind (not folded
      // into text) — else the boundary check below is vacuous when the leaf is
      // absent (Codex re-review Conf 97).
      const matching = leaves.filter((n) => n.leaf.kind === kind);
      expect(matching).toHaveLength(1);
      let cursor = matching[0].span.from;
      for (const p of leafBoundarySpans(matching[0].leaf)) {
        expect(p.to).toBeGreaterThanOrEqual(p.from); // reject reversed/overlapping spans (Conf 95)
        expect(p.from).toBe(cursor);
        cursor = p.to;
      }
      expect(cursor).toBe(matching[0].span.to);
    }
  });

  it("pins text values and emphasis delimiter span/length/char invariants", () => {
    const raw = "pre **a *b* c** post";
    for (const n of walkAll(parseCellInline(raw))) {
      if (n.kind === "text") {
        expect(raw.slice(n.span.from, n.span.to)).toBe(n.value);
      } else if (n.kind === "emphasis") {
        expect(n.span).toEqual({ from: n.openDelim.from, to: n.closeDelim.to });
        const want = n.tag === "strong" ? 2 : 1;
        expect(n.openDelim.to - n.openDelim.from).toBe(want);
        expect(n.closeDelim.to - n.closeDelim.from).toBe(want);
        const oc = raw.slice(n.openDelim.from, n.openDelim.to);
        const cc = raw.slice(n.closeDelim.from, n.closeDelim.to);
        expect(new Set(oc).size).toBe(1); // a run of one delimiter char
        expect(oc[0]).toBe(cc[0]);
      }
    }
  });
});

// Structure helpers for the boundary/invariant tests.
type LeafNode = Extract<Resolved<CellLeaf>, { kind: "leaf" }>;
function walkLeaves(ir: Resolved<CellLeaf>[]): LeafNode[] {
  const out: LeafNode[] = [];
  for (const n of ir) {
    if (n.kind === "leaf") {
      out.push(n);
    } else if (n.kind === "emphasis") {
      out.push(...walkLeaves(n.children));
    }
  }
  return out;
}
function walkAll(ir: Resolved<CellLeaf>[]): Resolved<CellLeaf>[] {
  const out: Resolved<CellLeaf>[] = [];
  for (const n of ir) {
    out.push(n);
    if (n.kind === "emphasis") {
      out.push(...walkAll(n.children));
    }
  }
  return out;
}
function leafBoundarySpans(leaf: CellLeaf): Span[] {
  switch (leaf.kind) {
    case "escape":
      return [leaf.marker, leaf.char];
    case "code":
      return [leaf.openFence, leaf.content, leaf.closeFence];
    case "link":
      return [
        leaf.openBracket,
        leaf.label,
        leaf.closeBracket,
        leaf.openParen,
        leaf.dest,
        leaf.closeParen,
      ];
    case "image":
      return [
        leaf.bang,
        leaf.openBracket,
        leaf.alt,
        leaf.closeBracket,
        leaf.openParen,
        leaf.dest,
        leaf.closeParen,
      ];
    case "autolink":
      return [leaf.openAngle, leaf.content, leaf.closeAngle];
  }
}

// renderReadonly merging is the part innerHTML CANNOT see — adjacent text /
// escape / inert-source / leftover-delimiter runs must collapse to ONE text
// node. Pin it by node count, not innerHTML (Codex plan review Conf 92).
describe("renderReadonly text-node topology (merging is not vacuous)", () => {
  it("merges an escape into surrounding text (`a\\|b` -> one text node `a|b`)", () => {
    const nodes = renderCellInline("a\\|b");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].nodeType).toBe(Node.TEXT_NODE);
    expect(nodes[0].textContent).toBe("a|b");
  });
  it("merges an inert unsafe construct into surrounding text (one node)", () => {
    const nodes = renderCellInline("x[bad](javascript:1)y");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe("x[bad](javascript:1)y");
  });
  it("merges unmatched delimiters into text (`x**unclosed` -> one node)", () => {
    const nodes = renderCellInline("x**unclosed");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe("x**unclosed");
  });
  it("merges an escaped pipe inside emphasis into one text child of <em>", () => {
    const nodes = renderCellInline("*a\\|b*");
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as Element).tagName).toBe("EM");
    expect(nodes[0].childNodes).toHaveLength(1);
    expect(nodes[0].textContent).toBe("a|b");
  });
});
