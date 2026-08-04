// @vitest-environment happy-dom
import { markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it, vi } from "vitest";
import { validateMarkdownForWrite } from "../../../src/markdown/validate-for-write.js";
import { htmlToMarkdown } from "../../../src/webview/cm/paste/html-to-markdown.js";

// The converter returns a discriminated result; these tests predate that and
// assert on the Markdown alone. `emittedMarkdownSyntax` is covered by its own describe
// block below.
const convert = (html: string): string | null => htmlToMarkdown(html)?.markdown ?? null;

// Built from code points, never pasted in as literal characters: an invisible byte
// sitting in a fixture cannot be reviewed, and an editor or a copy/paste edit can
// drop it without anyone noticing the test stopped testing anything.
const ZWSP = String.fromCharCode(0x200b); // U+200B ZERO WIDTH SPACE
const NBSP = String.fromCharCode(0xa0); // U+00A0 NO-BREAK SPACE

/** True when `md` parses (under Quoll's shipped GFM parser) to a tree containing a
 *  node named `name` — used to prove a converted construct actually renders as the
 *  intended Markdown node (emphasis pairs, a marker is a real ListMark) rather than
 *  degrading to literal characters. */
function parsesToNode(md: string, name: string): boolean {
  let found = false;
  markdownLanguage.parser.parse(md).iterate({
    enter: (n) => {
      if (n.name === name) {
        found = true;
      }
    },
  });
  return found;
}

/** True when `md` parses to a tree containing a `Table` node — used to prove
 *  pasted prose does not fabricate one. */
function formsGfmTable(md: string): boolean {
  return parsesToNode(md, "Table");
}

describe("htmlToMarkdown — inline constructs", () => {
  it("converts bold (<strong> and <b>)", () => {
    expect(convert("<p><strong>a</strong> <b>c</b></p>")).toBe("**a** **c**");
  });
  it("converts italic (<em> and <i>)", () => {
    expect(convert("<p><em>a</em> <i>c</i></p>")).toBe("*a* *c*");
  });
  it("hoists trailing space outside bold markers (CommonMark flanking)", () => {
    // `**foo **` would NOT close (a `**` after a space is not right-flanking) and
    // the literal `**` would show; the space must sit OUTSIDE the markers.
    expect(convert("<p><strong>foo </strong>bar</p>")).toBe("**foo** bar");
  });
  it("hoists leading and trailing space outside italic markers", () => {
    expect(convert("<p>a<em> b </em>c</p>")).toBe("a *b* c");
  });
  it("hoists leading-only space outside bold markers", () => {
    expect(convert("<p>a<strong> foo</strong></p>")).toBe("a **foo**");
  });
  it("pins the hoisted emphasis renders as emphasis, not literal markers", () => {
    // Behavioural pin: the shipped GFM parser must see a StrongEmphasis node — i.e.
    // the markers actually pair — for the whitespace-edged span.
    const md = convert("<p><strong>foo </strong>bar</p>") as string;
    expect(parsesToNode(md, "StrongEmphasis")).toBe(true);
  });
  it("hoists a <br> hard break out of an emphasis edge so it still renders", () => {
    // A `<br>` (`\\\n`) at the edge must be hoisted as a WHOLE token: `**foo\\\n**`
    // would not close (the closing `**` is newline-preceded → not right-flanking),
    // and a naive whitespace strip would split the escaping `\` from its newline.
    const md = convert("<p><strong>foo<br></strong>bar</p>") as string;
    expect(md).toBe("**foo**\\\nbar");
    expect(parsesToNode(md, "StrongEmphasis")).toBe(true);
  });
  it("hoists a leading <br> hard break out of an emphasis edge", () => {
    const md = convert("<p>a<em><br>foo</em></p>") as string;
    expect(md).toBe("a\\\n*foo*");
    expect(parsesToNode(md, "Emphasis")).toBe(true);
  });
  it("leaves an all-whitespace emphasis span unwrapped", () => {
    expect(convert("<p>a<strong> </strong>b</p>")).toBe("a b");
  });
  it("leaves a <br>-only emphasis span unwrapped (bare hard break, no markers)", () => {
    // The docblock's named case: an emphasis span whose only content is a `<br>`
    // must emit a bare hard break, never an empty `**\\\n**` (whose markers cannot
    // pair). The `start >= end` guard returns `inner` unwrapped.
    const md = convert("<p>a<strong><br></strong>b</p>") as string;
    expect(md).toBe("a\\\nb");
    expect(parsesToNode(md, "StrongEmphasis")).toBe(false);
  });
  it("hoists a <br> off BOTH edges of an emphasis span", () => {
    // Both breaks are hoisted OUTSIDE the markers (that is what keeps them
    // pairable). The leading one then sits at the start of the paragraph segment,
    // where pushInlineBlocks drops it — it would otherwise render as a line
    // holding nothing but the escaping backslash. The trailing one has "bar"
    // after it, so it stays a real hard break.
    const md = convert("<p><strong><br>foo<br></strong>bar</p>") as string;
    expect(md).toBe("**foo**\\\nbar");
    expect(parsesToNode(md, "StrongEmphasis")).toBe(true);
  });
  it("hoists a mixed space+<br> run at one edge (spans a token-type switch)", () => {
    const md = convert("<p><strong>foo<br> </strong>bar</p>") as string;
    expect(md).toBe("**foo**\\\n bar");
    expect(parsesToNode(md, "StrongEmphasis")).toBe(true);
  });
  it("keeps an interior (non-edge) <br> inside the emphasis markers", () => {
    const md = convert("<p><strong>foo<br>bar</strong></p>") as string;
    expect(md).toBe("**foo\\\nbar**");
    expect(parsesToNode(md, "StrongEmphasis")).toBe(true);
  });
  it("hoists a long <br> run fenced by text on both sides in linear time", () => {
    // Regression pin for the O(n²) backtracking a `^edge*? core edge*$` regex hit
    // on this exact shape (a long <br> run bounded by non-hoistable text). The
    // linear-scan hoist keeps it O(n); the prior regex took >2s here for K=40000.
    // Assert the MEDIAN of 3 samples, not min or a single reading: the median
    // tolerates one transient CI load spike (no flake, the O(n) scan runs ~150ms)
    // yet still fails when latency is sustained — the O(n²) regex was slow on every
    // sample, so its median stays >2s (min-of-N would mask a consistently-slow op).
    const K = 40000;
    const html = `<p><strong>x${"<br>".repeat(K)}x</strong>y</p>`;
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const md = convert(html);
      samples.push(performance.now() - t0);
      expect(md).not.toBeNull();
    }
    samples.sort((a, b) => a - b);
    expect(samples[1]).toBeLessThan(1200); // median of 3
  });
  it("converts inline code and does NOT escape its content", () => {
    expect(convert("<p><code>a*b_c</code></p>")).toBe("`a*b_c`");
  });
  it("wraps inline code containing a backtick with a longer fence", () => {
    expect(convert("<p><code>a`b</code></p>")).toBe("`` a`b ``");
  });
  it("converts an allowlisted link", () => {
    expect(convert('<p><a href="https://x.com">t</a></p>')).toBe("[t](https://x.com)");
  });
  it("folds a <br> inside a link label to a space, leaving no stray backslash", () => {
    // A label cannot span lines, so the hard break collapses — but it must go as a
    // WHOLE token. Removing only its newline left `[a\ b](…)`, and a backslash
    // before a space is not a CommonMark escape, so the user saw it in the label.
    expect(convert('<p><a href="https://x.com">a<br>b</a></p>')).toBe("[a b](https://x.com)");
  });

  it("degrades a disallowed-scheme link to its plain text", () => {
    expect(convert('<p><a href="javascript:alert(1)">t</a></p>')).toBe("t");
  });
  it("angle-brackets a link destination containing parens", () => {
    const md = convert('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">t</a></p>');
    expect(md).toBe("[t](<https://en.wikipedia.org/wiki/Foo_(bar)>)");
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
  it("escapes markdown-active characters in text so they stay literal", () => {
    expect(convert("<p>a*b_c[d]e`f</p>")).toBe("a\\*b\\_c\\[d\\]e\\`f");
  });
  it("does not break a bare URL autolink (schemes stay intact)", () => {
    expect(convert("<p>see https://x.com now</p>")).toBe("see https://x.com now");
  });
  it("converts <br> to a hard line break inside a paragraph", () => {
    expect(convert("<p>a<br>b</p>")).toBe("a\\\nb");
  });
  it("escapes a block-start marker smuggled onto a line after <br>", () => {
    // The core security property: a marker on ANY line — not just line 1 — is escaped.
    expect(convert("<p>a<br>- b</p>")).toBe("a\\\n\\- b");
  });
  it("deletes a zero-width character instead of collapsing it to a space", () => {
    // U+200B has no width, so `a<ZWSP>b` reads "ab". Folding it into the whitespace
    // run (the other way to neutralise it) would insert a gap between two letters
    // that touch in the source — the emptiness fix must not cost text fidelity.
    expect(convert(`<p>a${ZWSP}b</p>`)).toBe("ab");
  });
  it("collapses a text-node newline to a space (no indented code, no smuggled marker)", () => {
    expect(convert("<p>a\n    - b</p>")).toBe("a - b");
  });
  it("escapes pipes so pasted prose cannot fabricate a GFM table", () => {
    // A pipe line followed by a delimiter-shaped line (here split by <br>) would
    // otherwise parse as a GFM table header+delimiter — pasted prose must remain a
    // paragraph. escapeInline must escape `|` (mirroring escapeCell) to prevent it.
    const md = convert("<p>h1 | h2<br>:-|:-</p>");
    expect(md).toBe("h1 \\| h2\\\n:-\\|:-");
    // Behavioural pin against Quoll's shipped GFM parser: no Table node forms.
    expect(md).not.toBeNull();
    expect(formsGfmTable(md as string)).toBe(false);
  });
  it("percent-encodes a link destination containing angle brackets", () => {
    // isAllowedUrl accepts the raw href (scheme-only check, no normalisation), so a
    // `<`/`>`-bearing allowed URL reaches markdownDestination's encode branch; the
    // bytes must be percent-encoded so they cannot terminate the destination early.
    const md = convert('<p><a href="https://x.com/a<b>c">t</a></p>');
    expect(md).toBe("[t](https://x.com/a%3Cb%3Ec)");
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
  it("angle-brackets a link destination containing a space", () => {
    const md = convert('<p><a href="https://x.com/a b">t</a></p>');
    expect(md).toBe("[t](<https://x.com/a b>)");
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
  it("percent-encodes AND angle-wraps a destination with both a space and angle brackets", () => {
    // The combined case: `<`/`>` are percent-encoded, then the residual space
    // still forces the angle-bracket form — exercises markdownDestination's
    // `<${enc}>` sub-branch (distinct from the bare-encoded and no-encode paths).
    const md = convert('<p><a href="https://x.com/a b<c>d">t</a></p>');
    expect(md).toBe("[t](<https://x.com/a b%3Cc%3Ed>)");
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
  it("escapes a blockquote `>` marker at a line start", () => {
    expect(convert("<p>> not a quote</p>")).toBe("\\> not a quote");
  });
  it("escapes a `+` bullet marker at a line start", () => {
    expect(convert("<p>+ not a bullet</p>")).toBe("\\+ not a bullet");
  });
  it("escapes an ordered-list marker smuggled onto a line after <br>", () => {
    // Pins escapeMarkers' ordered-marker regex on the multiline (post-<br>) path,
    // distinct from the `-`/`#` single-line cases already covered.
    expect(convert("<p>a<br>1. b</p>")).toBe("a\\\n1\\. b");
  });
  it("returns null (never throws) on pathologically deep inline nesting", () => {
    const deep = `${"<b>".repeat(300)}x${"</b>".repeat(300)}`;
    expect(convert(deep)).toBeNull();
  });
  it("produces output the host write-gate accepts", () => {
    const md = convert('<p><a href="javascript:alert(1)">x</a> a|b ---</p>');
    expect(md).not.toBeNull();
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
});

describe("htmlToMarkdown — block constructs", () => {
  it("converts headings h1..h6", () => {
    expect(convert("<h1>A</h1><h3>B</h3>")).toBe("# A\n\n### B");
  });
  it("separates paragraphs with a blank line", () => {
    expect(convert("<p>a</p><p>b</p>")).toBe("a\n\nb");
  });
  it("converts an unordered list", () => {
    expect(convert("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });
  it("converts an ordered list honouring start", () => {
    expect(convert('<ol start="2"><li>a</li><li>b</li></ol>')).toBe("2. a\n3. b");
  });
  it("clamps a negative start to 0 (a valid ordinal, not `-3.`)", () => {
    // `-3.` is not a list marker → the item would degrade to a paragraph.
    expect(convert('<ol start="-3"><li>a</li><li>b</li></ol>')).toBe("0. a\n1. b");
  });
  it("clamps an oversized start to the 9-digit ListMark ceiling", () => {
    // A 10+-digit ordinal stops being a ListMark; clamp to MAX_LIST_NUMBER and do
    // not let the increment carry it past the ceiling either.
    expect(convert('<ol start="99999999999"><li>a</li><li>b</li></ol>')).toBe(
      "999999999. a\n999999999. b"
    );
  });
  it("falls back to 1 for a malformed (non-numeric) start", () => {
    expect(convert('<ol start="abc"><li>a</li><li>b</li></ol>')).toBe("1. a\n2. b");
  });
  it("pins a clamped ordinal as a real ListMark (negative and oversized starts)", () => {
    // Behavioural pin: the clamped marker must parse to an OrderedList under the
    // shipped GFM parser — string equality alone would not catch a future clamp or
    // parser change that quietly stopped producing a valid ListMark.
    const neg = convert('<ol start="-3"><li>a</li><li>b</li></ol>') as string;
    expect(parsesToNode(neg, "OrderedList")).toBe(true);
    const big = convert('<ol start="99999999999"><li>a</li><li>b</li></ol>') as string;
    expect(parsesToNode(big, "OrderedList")).toBe(true);
  });
  it("nests lists tightly with marker-width indentation", () => {
    expect(convert("<ul><li>a<ul><li>b</li></ul></li></ul>")).toBe("- a\n  - b");
  });
  it("unwraps a single <p> inside a list item", () => {
    expect(convert("<ul><li><p>a</p></li></ul>")).toBe("- a");
  });
  it("keeps two paragraphs in a list item as an indented loose item", () => {
    expect(convert("<ul><li><p>a</p><p>b</p></li></ul>")).toBe("- a\n\n  b");
  });
  it("renders a code block inside a list item (not flattened to inline code)", () => {
    expect(convert("<ul><li><pre><code>x</code></pre></li></ul>")).toBe("- ```\n  x\n  ```");
  });
  it("renders a blockquote inside a list item", () => {
    expect(convert("<ul><li><blockquote>q</blockquote></li></ul>")).toBe("- > q");
  });
  it("converts a fenced code block from <pre>, content unescaped", () => {
    expect(convert("<pre><code>a*b\nc</code></pre>")).toBe("```\na*b\nc\n```");
  });
  it("extracts a code fence language from a language- class", () => {
    expect(convert('<pre><code class="language-ts">x</code></pre>')).toBe("```ts\nx\n```");
  });
  it("ignores a malformed / unsafe code-fence language token", () => {
    expect(convert('<pre><code class="language-a`b c">x</code></pre>')).toBe("```\nx\n```");
  });
  it("uses a longer fence when <pre> content contains a backtick fence", () => {
    expect(convert("<pre>```\nx\n```</pre>")).toBe("````\n```\nx\n```\n````");
  });
  it("converts a blockquote with two paragraphs", () => {
    expect(convert("<blockquote><p>a</p><p>b</p></blockquote>")).toBe("> a\n>\n> b");
  });
  it("converts <hr> to a thematic break", () => {
    expect(convert("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });
  it("escapes block-start markers so prose stays literal", () => {
    expect(convert("<p>- not a bullet</p>")).toBe("\\- not a bullet");
    expect(convert("<p># not a heading</p>")).toBe("\\# not a heading");
    expect(convert("<p>1. not a list</p>")).toBe("1\\. not a list");
  });
  it("composes prose + table (reuses the table converter)", () => {
    const md = convert("<p>intro</p><table><tr><td>A</td><td>B</td></tr></table>");
    expect(md).toBe("intro\n\n| A | B |\n| --- | --- |");
  });
  it("defers the WHOLE fragment (null) when a table in a mixed fragment breaches its cap", () => {
    // The table exceeds the table converter's row cap → tableElementToGfm returns
    // null → the whole conversion aborts so plain-text paste preserves everything
    // (table + prose), rather than silently dropping the table.
    const bigTable = `<table>${"<tr><td>a</td></tr>".repeat(5001)}</table>`;
    expect(convert(`<p>intro</p>${bigTable}`)).toBeNull();
  });
  it("returns null for an empty / whitespace-only fragment", () => {
    expect(convert("<p>   </p>")).toBeNull();
    expect(convert("")).toBeNull();
  });
  it("returns null when the input exceeds the size cap", () => {
    expect(convert(`<p>${"a".repeat(2 * 1024 * 1024 + 1)}</p>`)).toBeNull();
  });
  it("returns null when the node cap is breached (never throws)", () => {
    const deep = `${"<div>".repeat(60_000)}x${"</div>".repeat(60_000)}`;
    expect(convert(deep)).toBeNull();
  });
  it("returns null when the block depth cap is breached", () => {
    const nested = `${"<blockquote>".repeat(200)}x${"</blockquote>".repeat(200)}`;
    expect(convert(nested)).toBeNull();
  });
  it("returns null when table colspan expansion blows the output cap (small input, huge output)", () => {
    // Each table expands to ~1000 columns of GFM (~a few KB); ~2000 of them
    // exceed MAX_OUTPUT_CHARS while the INPUT stays well under the 2 MiB input cap
    // and the node count under MAX_NODES. The incremental output counter must
    // abort mid-build and return null (not build gigabytes then check).
    const oneTable = '<table><tr><td colspan="1000">x</td></tr></table>';
    expect(convert(oneTable.repeat(2000))).toBeNull();
  });
});

describe("htmlToMarkdown — emittedMarkdownSyntax discriminator", () => {
  it("is false for a text-only fragment (nothing the plain text lacks)", () => {
    const result = htmlToMarkdown("<p>- [ ] a task</p>");
    expect(result).not.toBeNull();
    expect(result?.emittedMarkdownSyntax).toBe(false);
  });

  it("is false for a fragment whose only markup is presentational", () => {
    const result = htmlToMarkdown('<div><span style="color:red">plain</span></div>');
    expect(result?.emittedMarkdownSyntax).toBe(false);
  });

  it("is false for a <br> hard break (line structure, not syntax)", () => {
    const result = htmlToMarkdown("one<br>two");
    expect(result?.emittedMarkdownSyntax).toBe(false);
  });

  it.each([
    ["emphasis", "<p><strong>x</strong></p>"],
    ["italic", "<p><em>x</em></p>"],
    ["inline code", "<p><code>x</code></p>"],
    ["heading", "<h1>x</h1>"],
    ["bullet list", "<ul><li>x</li></ul>"],
    ["ordered list", "<ol><li>x</li></ol>"],
    ["blockquote", "<blockquote><p>x</p></blockquote>"],
    ["fenced code", "<pre>x</pre>"],
    ["thematic break", "<p>a</p><hr><p>b</p>"],
    ["table", "<table><tr><td>x</td></tr></table>"],
    ["allowed link", '<p><a href="https://example.com">x</a></p>'],
    ["menu list", "<menu><li>x</li></menu>"],
  ])("is true for %s", (_label, html) => {
    expect(htmlToMarkdown(html)?.emittedMarkdownSyntax).toBe(true);
  });

  it.each([
    ["empty blockquote", "<div>- [ ] task</div><blockquote></blockquote>"],
    ["whitespace-only blockquote", "<div>- [ ] task</div><blockquote>  </blockquote>"],
    ["empty pre", "<div>- [ ] task</div><pre></pre>"],
    ["empty heading", "<div>- [ ] task</div><h1></h1>"],
    ["empty list", "<div>- [ ] task</div><ul></ul>"],
    ["list of one empty item", "<div>- [ ] task</div><ul><li></li></ul>"],
    ["ordered list of empty items", "<div>- [ ] task</div><ol><li></li><li></li></ol>"],
    ["list item holding only a <br>", "<div>- [ ] task</div><ul><li><br></li></ul>"],
    ["heading holding only a <br>", "<div>- [ ] task</div><h1><br></h1>"],
    ["empty inline code span", "<div>- [ ] task</div><div><code></code></div>"],
    ["link with an empty label", '<div>- [ ] task</div><p><a href="https://t.co/x"></a></p>'],
    [
      "link wrapping only a tracking pixel",
      '<div>- [ ] task</div><p><a href="https://t.co/x"><img src="p.gif"></a></p>',
    ],
    [
      "blockquote holding only an empty list",
      "<div>- [ ] task</div><blockquote><ul><li></li></ul></blockquote>",
    ],
    // The one shape hasTextContent alone cannot settle: the <li> HAS text, but all
    // of it lives in a SKIP_TAGS subtree that serialisation drops. Pins the second,
    // narrower guard inside serializeListItem — without it the item falls back to a
    // bare `-` marker and the list is pushed as syntax again.
    [
      "list item holding only a <style>",
      "<div>- [ ] task</div><ul><li><style>a{}</style></li></ul>",
    ],
    // The zero-width class: U+200B is what a contenteditable (Notion / Slack /
    // Quill / ProseMirror) leaves behind in a block the user has emptied, and
    // `trim()` does not strip it. The emphasis row is the one that could NOT be
    // settled by patching the emptiness predicate — `emphasize` never consults it —
    // which is why the normalisation lives on the shared text path instead.
    // <pre> and inline <code> are the two branches with no residue guard behind
    // them — they emit `el.textContent` directly — so these two rows are what
    // observe the emptiness predicate itself normalising its input. The heading and
    // list rows below would stay green on the predicate alone (their residue guards
    // absorb the zero width); they pin the outcome, not the mechanism.
    ["<pre> holding only a zero-width space", `<div>- [ ] task</div><pre>${ZWSP}</pre>`],
    [
      "code span holding only a zero-width space",
      `<div>- [ ] task</div><div><code>${ZWSP}</code></div>`,
    ],
    ["heading holding only a zero-width space", `<div>- [ ] task</div><h1>${ZWSP}</h1>`],
    ["list item holding only a zero-width space", `<div>- [ ] task</div><ul><li>${ZWSP}</li></ul>`],
    [
      "emphasis span holding only a zero-width space",
      `<div>- [ ] task</div><p><strong>${ZWSP}</strong></p>`,
    ],
    // The already-correct neighbour, previously unpinned in either direction: a
    // non-breaking space is invisible-ish too and must keep the same answer, so a
    // future edit cannot change one boundary while believing it moved the other.
    ["heading holding only a non-breaking space", `<div>- [ ] task</div><h1>${NBSP}</h1>`],
  ])("is false for an %s (an empty container is not rich content)", (_label, html) => {
    // The wrapper mail clients leave behind in quoted HTML, the empty bullet a
    // contenteditable leaves behind, the tracking pixel a marketing mail wraps in a
    // link. Flipping the flag for one would defeat the handler's no-syntax defer and
    // re-escape the user's own markers — the bug this PR exists to fix.
    //
    // Every one of these renders to something NON-EMPTY when its branch decides
    // emptiness on its own output ("-", "1.\n2.", "``", "[](url)", "# \\"), which is
    // why the decision belongs to hasTextContent on the SOURCE element and not to
    // per-branch string tests. The container must also emit NO block.
    const result = htmlToMarkdown(html);
    expect(result?.emittedMarkdownSyntax).toBe(false);
    expect(result?.markdown).toBe("\\- \\[ \\] task");
  });

  it.each([
    ["a list with real items", "<ul><li>a</li></ul>", "\\- \\[ \\] task\n\n- a"],
    ["a <pre> holding real code", "<pre>x</pre>", "\\- \\[ \\] task\n\n```\nx\n```"],
    ["a heading with text", "<h1>T</h1>", "\\- \\[ \\] task\n\n# T"],
    ["a code span with content", "<div><code>x</code></div>", "\\- \\[ \\] task\n\n`x`"],
    [
      "a link with a label",
      '<p><a href="https://example.com">x</a></p>',
      "\\- \\[ \\] task\n\n[x](https://example.com)",
    ],
    ["a thematic break", "<hr>", "\\- \\[ \\] task\n\n---"],
    ["a table", "<table><tr><td>c</td></tr></table>", "\\- \\[ \\] task\n\n| c |\n| --- |"],
    ["a blockquote with text", "<blockquote>q</blockquote>", "\\- \\[ \\] task\n\n> q"],
  ])("stays true for %s beside the same plain text (the emptiness guard must not over-reach)", (_label, rich, expected) => {
    // The other half of the guard above: making every container non-rich would
    // satisfy the empty cases and silently stop rich clipboards converting at all.
    // <hr> is the one construct that carries no text yet is real syntax, so its row
    // is what would catch a future edit routing it through hasTextContent. The
    // <table> row does NOT pin that — its cell holds "c", so it passes the
    // predicate either way; what it pins is that a table with cell TEXT stays rich.
    // The text-free grid, which is the shape the predicate actually decides, has
    // its own two tests below.
    const result = htmlToMarkdown(`<div>- [ ] task</div>${rich}`);
    expect(result?.emittedMarkdownSyntax).toBe(true);
    expect(result?.markdown).toBe(expected);
  });

  it("does not call a text-free spacer table rich, but still emits its grid", () => {
    // A layout/spacer grid — Outlook, mail signatures, newsletter HTML — riding
    // beside the user's own prose. Counting it as rich defeats the handler's
    // no-syntax defer and re-escapes the hand-typed markers, the bug this PR
    // exists to fix. The grid is still emitted so the sibling case below keeps it.
    const result = htmlToMarkdown(
      "<div>- [ ] task</div><table><tr><td></td><td></td></tr></table>"
    );
    expect(result?.emittedMarkdownSyntax).toBe(false);
    expect(result?.markdown).toBe("\\- \\[ \\] task\n\n|  |  |\n| --- | --- |");
  });

  it("keeps a text-free grid in the output when the fragment is rich for another reason", () => {
    // The other half: emitting is not the same question as being rich. Skipping the
    // grid outright (rather than only declining to call it rich) would silently drop
    // it out of a fragment that converts anyway.
    const result = htmlToMarkdown("<h1>Title</h1><table><tr><td></td></tr></table>");
    expect(result?.emittedMarkdownSyntax).toBe(true);
    expect(result?.markdown).toBe("# Title\n\n|  |\n| --- |");
  });

  it("drops only the empty items from a mixed list, without advancing the ordinal", () => {
    // An empty <li> is not an item, so it must not consume a number either —
    // otherwise a contenteditable's leftover bullet renumbers everything after it.
    const result = htmlToMarkdown("<ol><li>a</li><li></li><li>b</li></ol>");
    expect(result?.markdown).toBe("1. a\n2. b");
    expect(result?.emittedMarkdownSyntax).toBe(true);
  });

  it.each([
    ["spaces only", "<pre>  </pre>"],
    ["newline + indentation", "<pre>\n   \n</pre>"],
    ["blank lines only", "<pre>\n\n</pre>"],
  ])("is false for a whitespace-only <pre> (%s)", (_label, pre) => {
    // The richness DECISION is trim-based, so a content-free <pre> joins the empty
    // containers above: no fence is emitted and the user's hand-typed `- [ ]`
    // survives unescaped. The multi-line shapes are how this regressed — a guard
    // that stripped one trailing newline read "\n   \n" as content, flipped the
    // flag, and re-escaped the checklist this PR exists to fix.
    //
    // Whitespace-significance is an OUTPUT concern only, and is pinned separately
    // by "emits a real <pre> body verbatim" below. The two must not be conflated:
    // deciding on the trimmed body does NOT license trimming what gets emitted.
    const result = htmlToMarkdown(`<div>- [ ] task</div>${pre}`);
    expect(result?.emittedMarkdownSyntax).toBe(false);
    expect(result?.markdown).toBe("\\- \\[ \\] task");
  });

  it("is true for a <pre> holding real code", () => {
    // The positive half of the guard above. Without it, making EVERY <pre>
    // non-rich would satisfy the whitespace cases and fenced code would silently
    // stop counting as Markdown syntax.
    const result = htmlToMarkdown("<div>- [ ] task</div><pre>x</pre>");
    expect(result?.emittedMarkdownSyntax).toBe(true);
    expect(result?.markdown).toBe("\\- \\[ \\] task\n\n```\nx\n```");
  });

  it("emits a real <pre> body verbatim, without trimming its whitespace", () => {
    // Code is whitespace-significant: once the <pre> has content, leading
    // indentation and interior blank lines are part of it and must survive.
    expect(htmlToMarkdown("<pre>  indented\n\n  tail\n</pre>")?.markdown).toBe(
      "```\n  indented\n\n  tail\n```"
    );
  });

  it("is false for a link whose href is not allowlisted (label only, no syntax)", () => {
    const result = htmlToMarkdown('<p><a href="javascript:alert(1)">x</a></p>');
    expect(result?.markdown).toBe("x");
    expect(result?.emittedMarkdownSyntax).toBe(false);
  });

  it("is false for an emphasis span that wraps nothing (all whitespace)", () => {
    const result = htmlToMarkdown("<p>a<strong> </strong>b</p>");
    expect(result?.emittedMarkdownSyntax).toBe(false);
  });

  it("still returns null when there is nothing convertible", () => {
    expect(htmlToMarkdown("   ")).toBeNull();
  });

  it("degrades a cap breach to null SILENTLY (the sentinel is the expected path)", () => {
    // The caller can consume a `null` (rich-html-paste.ts swallows one to protect a
    // selection), so an unexpected throw in the walk must leave a console trace or
    // it presents as "the paste did nothing". A cap breach is NOT that case: it is
    // the designed degradation for oversized/too-deep input and must stay quiet, or
    // every large paste would warn. Pins the discrimination, not just the return.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tooDeep = `${"<div>".repeat(40)}x${"</div>".repeat(40)}`;
      expect(htmlToMarkdown(tooDeep)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("htmlToMarkdown — expected degradation vs. reportable fault", () => {
  // Every failure in this module returns the SAME `null`, and the caller logs one
  // outcome for all of them ("unconvertible HTML-only clipboard dropped"), which
  // blames the user's clipboard. The console line is therefore the only thing that
  // separates "this input is too big / not convertible" from "this module or its
  // environment is broken" — a dev-visible signal with two sides, so both are
  // pinned here, the way cm-table-fallback-warn.test.ts pins its fallback warning.
  //
  // Not asserted: the message text. What is contractual is WHETHER a fault leaves a
  // trace, not its wording.
  const withWarnSpy = (body: (warn: ReturnType<typeof vi.spyOn>) => void): void => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      body(warn);
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  };

  it.each([
    ["input over the size cap", "x".repeat(3 * 1024 * 1024)],
    ["nothing convertible at all", "   "],
    ["a fragment past the depth cap", `${"<div>".repeat(40)}x${"</div>".repeat(40)}`],
  ])("stays silent for %s (expected degradation)", (_label, html) => {
    withWarnSpy((warn) => {
      expect(htmlToMarkdown(html)).toBeNull();
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it("warns when DOMParser itself throws", () => {
    // DOMParser is a platform global and text/html parsing does not throw on
    // malformed input, so a throw here is an environment or converter fault. It
    // used to be a bare `return null`, indistinguishable from an unconvertible
    // clipboard and invisible everywhere.
    withWarnSpy((warn) => {
      vi.stubGlobal(
        "DOMParser",
        class {
          parseFromString(): Document {
            throw new Error("parser exploded");
          }
        }
      );
      expect(htmlToMarkdown("<p>x</p>")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it("warns when the parsed document has no body", () => {
    withWarnSpy((warn) => {
      vi.stubGlobal(
        "DOMParser",
        class {
          parseFromString(): { body: null } {
            return { body: null };
          }
        }
      );
      expect(htmlToMarkdown("<p>x</p>")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });

  it("warns when the walk throws something that is not a cap breach", () => {
    // The third fault site, and the one the CapExceeded discrimination is about:
    // the walk's catch must tell its own sentinel apart from a real bug. A body
    // whose childNodes getter throws reaches serializeBlocks and blows up there.
    withWarnSpy((warn) => {
      const body = {
        get childNodes(): never {
          throw new TypeError("boom");
        },
      };
      vi.stubGlobal(
        "DOMParser",
        class {
          parseFromString(): { body: unknown } {
            return { body };
          }
        }
      );
      expect(htmlToMarkdown("<p>x</p>")).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});

describe("htmlToMarkdown — block separators", () => {
  it("keeps sibling <div> lines as separate blocks", () => {
    // A <div> is block-level even when it holds only inline children; folding it
    // into the inline run merged the lines.
    expect(htmlToMarkdown("<div><span>one</span></div><div><span>two</span></div>")?.markdown).toBe(
      "one\n\ntwo"
    );
  });

  it("treats a run of 2+ <br> as a block separator, not a hard break", () => {
    expect(htmlToMarkdown("one<br><br>two")?.markdown).toBe("one\n\ntwo");
  });

  it("keeps a single <br> as a hard break", () => {
    expect(htmlToMarkdown("one<br>two")?.markdown).toBe("one\\\ntwo");
  });

  it("emits nothing for a <br>-only block instead of a stray backslash", () => {
    expect(htmlToMarkdown("<p>one</p><p><br></p><p>two</p>")?.markdown).toBe("one\n\ntwo");
  });

  it("drops a <br> separating two block-level siblings", () => {
    expect(
      htmlToMarkdown("<div><span>one</span></div><br><div><span>two</span></div>")?.markdown
    ).toBe("one\n\ntwo");
  });

  it("preserves rich structure across separated blocks", () => {
    expect(
      htmlToMarkdown("<div><strong>one</strong></div><br><div><em>two</em></div>")?.markdown
    ).toBe("**one**\n\n*two*");
  });

  it("keeps a <br> run together when whitespace pretty-printing separates it", () => {
    // Real clipboard HTML is pretty-printed; the newline between the two breaks
    // must not demote the run to two single hard breaks.
    expect(htmlToMarkdown("one<br>\n<br>two")?.markdown).toBe("one\n\ntwo");
  });

  it("splits a <br> run inside a single paragraph into separate blocks", () => {
    // The `<p>` branch shares pushInlineBlocks, so an email-style `a<br><br>b`
    // paragraph splits too — pin it, since only the bare top-level shape is
    // covered above.
    expect(htmlToMarkdown("<p>a<br><br>b</p>")?.markdown).toBe("a\n\nb");
  });

  it("keeps whitespace around a LONE <br> (only a 2+ run is a separator)", () => {
    // The lone break stays inline, so the whitespace buffered while deciding
    // whether a second break followed must come back with it — not be eaten.
    expect(htmlToMarkdown("one<br>\ntwo")?.markdown).toBe("one\\\n two");
  });

  it("serialises <menu> as a list, not a collapsed inline run", () => {
    expect(htmlToMarkdown("<menu><li>one</li><li>two</li></menu>")?.markdown).toBe("- one\n- two");
  });

  it("gives a non-obvious block container its own block", () => {
    // The block-level set is not just DIV — an omitted tag folds back into the
    // inline run, which is the bug this task fixes.
    expect(htmlToMarkdown("<details>one</details><address>two</address>")?.markdown).toBe(
      "one\n\ntwo"
    );
  });

  it("keeps a <br> run together across a comment (Word/Outlook clipboard HTML)", () => {
    // The `<p>` caller used to pass raw childNodes while the inline-run caller
    // pre-filtered, so the same markup split differently depending on its parent.
    expect(htmlToMarkdown("<p>a<br><!--[if !supportLists]--><br>b</p>")?.markdown).toBe("a\n\nb");
    expect(htmlToMarkdown("a<br><!--[if !supportLists]--><br>b")?.markdown).toBe("a\n\nb");
  });

  it("keeps a <br> run together across a SKIP_TAGS element", () => {
    expect(htmlToMarkdown("<p>a<br><style>x{}</style><br>b</p>")?.markdown).toBe("a\n\nb");
  });

  it("drops a trailing <br> instead of stranding its backslash", () => {
    // Browsers append a <br> to close the last line of a contenteditable block.
    // Trimming the token as a unit is what stops the `\` surviving alone.
    expect(htmlToMarkdown("<p>a<br></p><p>b</p>")?.markdown).toBe("a\n\nb");
    expect(htmlToMarkdown("<p>one<br></p>")?.markdown).toBe("one");
  });

  it("drops a leading <br> instead of stranding its backslash", () => {
    expect(htmlToMarkdown("<p><br>one</p>")?.markdown).toBe("one");
  });

  it("still keeps an INTERIOR lone <br> as a hard break", () => {
    // Edge-trimming must not touch a break with content on both sides — that is
    // the hard break the converter is supposed to emit.
    expect(htmlToMarkdown("<p>a<br>b</p>")?.markdown).toBe("a\\\nb");
  });

  it("gives a stray <li> its own block (a copy that starts mid-list)", () => {
    // Bare top-level <li>s used to fold into one inline run and come out glued
    // together with no separator at all.
    expect(htmlToMarkdown("<li>a</li><li>b</li>")?.markdown).toBe("a\n\nb");
  });

  it("still renders <li>s inside a list as list items, not stray blocks", () => {
    // serializeList consumes them directly, so adding LI to the block-level set
    // must not change list rendering.
    expect(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")?.markdown).toBe("- a\n- b");
  });

  it("does NOT split a <br> run nested inside an emphasis span", () => {
    // The run belongs to the span's inline content, so it stays a hard break —
    // splitting the serialised string here would tear `**x` from `y**`. Markdown
    // cannot express a paragraph break inside emphasis; keeping the span intact
    // is the lesser evil and is the shape the O(n) hoist test also relies on.
    expect(htmlToMarkdown("<p><strong>x<br><br>y</strong>z</p>")?.markdown).toBe("**x\\\n\\\ny**z");
  });
});
