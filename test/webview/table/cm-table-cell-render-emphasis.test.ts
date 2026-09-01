// @vitest-environment happy-dom
// The shared delimiter stack. `*`/`_` (emphasis, strong), `~~` (strikethrough)
// and `==` (highlight) are not four features but one: all four are emitted as
// delimiter runs into the SAME stack (inline-emphasis.ts) and paired by a single
// `resolveInline` pass, which is why they nest and interleave with each other,
// and why the interleaving rows here (`*a~~b*c~~d*`, `*a==b*c==d*`,
// `~~a ==b== c~~`) belong with the emphasis rows rather than in a marks suite of
// their own — splitting the two would leave those rows with no home that owns
// both sides.
// The last row is where the stack STOPS: past MAX_INLINE_NESTING_DEPTH the
// walker quits recursing and renders literal source. It sat inside the text-node
// topology describe before this split, which is not what it asserts.
// The oracle for these expectations is @lezer/markdown, the parser the editor
// itself runs — EXCEPT the astral-plane flanking rows, which say in place why
// they use the CommonMark spec and markdown-it instead.
import { describe, expect, it } from "vitest";

import { renderCellInline } from "../../../src/webview/cm/table/cell-render.js";
import { html, htmlWithoutTooltip } from "./helpers/cell-render-fixtures.js";

describe("renderCellInline — the shared delimiter stack (emphasis, strong, strikethrough, highlight)", () => {
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
    expect(htmlWithoutTooltip(renderCellInline("*[ok](https://x.test)*"))).toBe(
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

  // Strikethrough (`~~…~~`) + highlight (`==…==`) parity: these render formatted
  // everywhere else in the editor, but the table-cell widget used to leak the raw
  // delimiters (`| ~~x~~ |` showed the tildes). They are emitted as delimiter runs
  // into the SAME stack as `*`/`_` (inline-emphasis.ts), so resolveInline pairs
  // them into <del>/<mark> wraps that interleave with emphasis exactly as the
  // editor's @lezer/markdown parser does.
  it("renders `~~x~~` as a live <del> (strikethrough)", () => {
    expect(html(renderCellInline("~~x~~"))).toBe("<del>x</del>");
  });

  it("renders `==x==` as a live <mark> (highlight)", () => {
    expect(html(renderCellInline("==x=="))).toBe("<mark>x</mark>");
  });

  it("nests emphasis inside a mark (`~~*x*~~`, `==**b**==`)", () => {
    expect(html(renderCellInline("~~*x*~~"))).toBe("<del><em>x</em></del>");
    expect(html(renderCellInline("==**b**=="))).toBe("<mark><strong>b</strong></mark>");
  });

  it("renders a mark amid surrounding text (`a ~~b~~ ==c== d`)", () => {
    expect(html(renderCellInline("a ~~b~~ ==c== d"))).toBe("a <del>b</del> <mark>c</mark> d");
  });

  // Flanking parity with the source parsers: a leading space after the opener
  // means it cannot open, so the run stays literal (the editor would not strike
  // it either). The `a == b` case is the common false-trigger — an `==` flanked
  // by spaces neither opens nor closes.
  it("leaves a non-flanking mark literal (`~~ x~~`, `a == b`)", () => {
    expect(html(renderCellInline("~~ x~~"))).toBe("~~ x~~");
    expect(html(renderCellInline("a == b"))).toBe("a == b");
  });

  // An unmatched opener (no closing pair) stays literal — the delimiter run
  // survives as its literal characters, merged with adjacent text.
  it("leaves an unmatched mark opener literal (`~~x`, `a==b`)", () => {
    expect(html(renderCellInline("~~x"))).toBe("~~x");
    expect(html(renderCellInline("a==b"))).toBe("a==b");
  });

  // A `~~`/`==` inside inline code is inert (code binds tighter, content literal).
  it("does not mark inside an inline code span (`` `~~x~~` ``)", () => {
    expect(html(renderCellInline("`~~x~~`"))).toBe("<code>~~x~~</code>");
  });

  // Shared-delimiter-stack interleaving parity. A greedy nearest-closer scan
  // would mis-pair these; the delimiter stack reproduces @lezer/markdown exactly.
  // `*a~~b*c~~d*`: emphasis wins, the crossing `~~` are left inert. Verified
  // against @lezer/markdown + GFM directly (code-quality review).
  it("interleaves a mark with emphasis like the editor (`*a~~b*c~~d*`)", () => {
    expect(html(renderCellInline("*a~~b*c~~d*"))).toBe("<em>a~~b</em>c~~d*");
  });

  // Nested same-type marks: outer wraps the inner via the delimiter stack, no
  // literal tail left behind (the greedy scan closed the outer at the inner).
  it("nests same-type marks (`~~a ~~b~~ c~~`)", () => {
    expect(html(renderCellInline("~~a ~~b~~ c~~"))).toBe("<del>a <del>b</del> c</del>");
  });

  // The SAME interleave/nesting behaviour on the `==` side (highlight is the
  // newer, less battle-tested delimiter — pin it independently so a future edit
  // that broke only the `=` slot / `mark` tag branch cannot pass on `~~` alone).
  it("interleaves `==` with emphasis like the editor (`*a==b*c==d*`)", () => {
    expect(html(renderCellInline("*a==b*c==d*"))).toBe("<em>a==b</em>c==d*");
  });

  it("nests same-type highlight marks (`==a ==b== c==`)", () => {
    expect(html(renderCellInline("==a ==b== c=="))).toBe("<mark>a <mark>b</mark> c</mark>");
  });

  // Cross-type nesting: a highlight inside a strikethrough, resolved in the one
  // shared stack (both are length-2 delimiters that only differ by tag).
  it("nests a highlight inside a strikethrough (`~~a ==b== c~~`)", () => {
    expect(html(renderCellInline("~~a ==b== c~~"))).toBe("<del>a <mark>b</mark> c</del>");
  });

  // Triple run: Lezer rescans from pos+1, so `===x===` opens at [1,3) and closes
  // at [5,7), wrapping content `x=` (Highlight span [1,7) — the measured span
  // highlight-mark.ts documents). Only the leading `=` (index 0) stays literal.
  it("handles a triple-delimiter run like the editor (`===x===`)", () => {
    expect(html(renderCellInline("===x==="))).toBe("=<mark>x=</mark>");
  });

  // The mark wrap does NOT bypass the URL render-gate: an unsafe link nested
  // inside `~~…~~` still renders inert (mirrors the emphasis arm's
  // `**[bad](javascript:1)**` case). The link leaf carries the safeUrl=null
  // verdict; the surrounding del/mark is just a wrapper.
  it("keeps the URL gate for an unsafe link inside a mark (`~~[bad](javascript:1)~~`)", () => {
    expect(html(renderCellInline("~~[bad](javascript:1)~~"))).toBe(
      "<del>[bad](javascript:1)</del>"
    );
  });

  it("keeps a safe link live inside a mark (`==[ok](https://x.test)==`)", () => {
    expect(htmlWithoutTooltip(renderCellInline("==[ok](https://x.test)=="))).toBe(
      '<mark><a href="https://x.test" rel="noopener noreferrer">ok</a></mark>'
    );
  });

  // Image alt (commonMarkAltText → flattenInlineText) flattens a mark to its
  // text content, same as emphasis — used for `<img alt>` in both the table-cell
  // renderer and the shared block-image widget.
  it("flattens a mark in an image alt (`![a ~~b~~ c](url)` -> alt=`a b c`)", () => {
    const nodes = renderCellInline("![a ~~b~~ c](https://x.test/i.png)");
    expect((nodes[0] as HTMLImageElement).alt).toBe("a b c");
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
    expect(htmlWithoutTooltip(renderCellInline("[a *b* c](https://x.test)"))).toBe(
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

  it("renders a pathologically deep-emphasis cell without crashing", () => {
    // ~N/2-deep emphasis nesting — the seed-time stack-overflow vector. The
    // walker must fall back to inert literal source past the nesting cap
    // instead of overflowing while walking the (bounded-build) tree.
    const N = 40000;
    const deep = `${"*".repeat(N)}a${"*".repeat(N)}`;
    let nodes: Node[] = [];
    expect(() => {
      nodes = renderCellInline(deep);
    }).not.toThrow();
    const text = nodes.map((n) => n.textContent ?? "").join("");
    // Content survives (the literal `a` is preserved past the cap)...
    expect(text).toContain("a");
    // ...and the inert-source fallback actually fired: literal `*` delimiters
    // leak into the text (a vacuous always-empty render would not contain them).
    expect(text).toContain("*");
    // Non-vacuity vs the defense-in-depth try/catch: the WALKER cap emits only
    // the emphasis span at depth 100 (the outer ~2×cap delimiters are unwrapped
    // first), so the text is strictly shorter than the raw input. The try/catch
    // fallback would instead return the FULL raw string as one text node — this
    // pins that the cap path ran, not that an overflow was silently caught.
    expect(text.length).toBeLessThan(deep.length);
  });
});
