// @vitest-environment happy-dom
import { markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { validateMarkdownForWrite } from "../../../src/markdown/validate-for-write.js";
import { htmlToMarkdown } from "../../../src/webview/cm/paste/html-to-markdown.js";

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
    expect(htmlToMarkdown("<p><strong>a</strong> <b>c</b></p>")).toBe("**a** **c**");
  });
  it("converts italic (<em> and <i>)", () => {
    expect(htmlToMarkdown("<p><em>a</em> <i>c</i></p>")).toBe("*a* *c*");
  });
  it("hoists trailing space outside bold markers (CommonMark flanking)", () => {
    // `**foo **` would NOT close (a `**` after a space is not right-flanking) and
    // the literal `**` would show; the space must sit OUTSIDE the markers.
    expect(htmlToMarkdown("<p><strong>foo </strong>bar</p>")).toBe("**foo** bar");
  });
  it("hoists leading and trailing space outside italic markers", () => {
    expect(htmlToMarkdown("<p>a<em> b </em>c</p>")).toBe("a *b* c");
  });
  it("hoists leading-only space outside bold markers", () => {
    expect(htmlToMarkdown("<p>a<strong> foo</strong></p>")).toBe("a **foo**");
  });
  it("pins the hoisted emphasis renders as emphasis, not literal markers", () => {
    // Behavioural pin: the shipped GFM parser must see a StrongEmphasis node — i.e.
    // the markers actually pair — for the whitespace-edged span.
    const md = htmlToMarkdown("<p><strong>foo </strong>bar</p>") as string;
    expect(parsesToNode(md, "StrongEmphasis")).toBe(true);
  });
  it("hoists a <br> hard break out of an emphasis edge so it still renders", () => {
    // A `<br>` (`\\\n`) at the edge must be hoisted as a WHOLE token: `**foo\\\n**`
    // would not close (the closing `**` is newline-preceded → not right-flanking),
    // and a naive whitespace strip would split the escaping `\` from its newline.
    const md = htmlToMarkdown("<p><strong>foo<br></strong>bar</p>") as string;
    expect(md).toBe("**foo**\\\nbar");
    expect(parsesToNode(md, "StrongEmphasis")).toBe(true);
  });
  it("hoists a leading <br> hard break out of an emphasis edge", () => {
    const md = htmlToMarkdown("<p>a<em><br>foo</em></p>") as string;
    expect(md).toBe("a\\\n*foo*");
    expect(parsesToNode(md, "Emphasis")).toBe(true);
  });
  it("leaves an all-whitespace emphasis span unwrapped", () => {
    expect(htmlToMarkdown("<p>a<strong> </strong>b</p>")).toBe("a b");
  });
  it("converts inline code and does NOT escape its content", () => {
    expect(htmlToMarkdown("<p><code>a*b_c</code></p>")).toBe("`a*b_c`");
  });
  it("wraps inline code containing a backtick with a longer fence", () => {
    expect(htmlToMarkdown("<p><code>a`b</code></p>")).toBe("`` a`b ``");
  });
  it("converts an allowlisted link", () => {
    expect(htmlToMarkdown('<p><a href="https://x.com">t</a></p>')).toBe("[t](https://x.com)");
  });
  it("degrades a disallowed-scheme link to its plain text", () => {
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">t</a></p>')).toBe("t");
  });
  it("angle-brackets a link destination containing parens", () => {
    const md = htmlToMarkdown('<p><a href="https://en.wikipedia.org/wiki/Foo_(bar)">t</a></p>');
    expect(md).toBe("[t](<https://en.wikipedia.org/wiki/Foo_(bar)>)");
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
  it("escapes markdown-active characters in text so they stay literal", () => {
    expect(htmlToMarkdown("<p>a*b_c[d]e`f</p>")).toBe("a\\*b\\_c\\[d\\]e\\`f");
  });
  it("does not break a bare URL autolink (schemes stay intact)", () => {
    expect(htmlToMarkdown("<p>see https://x.com now</p>")).toBe("see https://x.com now");
  });
  it("converts <br> to a hard line break inside a paragraph", () => {
    expect(htmlToMarkdown("<p>a<br>b</p>")).toBe("a\\\nb");
  });
  it("escapes a block-start marker smuggled onto a line after <br>", () => {
    // The core security property: a marker on ANY line — not just line 1 — is escaped.
    expect(htmlToMarkdown("<p>a<br>- b</p>")).toBe("a\\\n\\- b");
  });
  it("collapses a text-node newline to a space (no indented code, no smuggled marker)", () => {
    expect(htmlToMarkdown("<p>a\n    - b</p>")).toBe("a - b");
  });
  it("escapes pipes so pasted prose cannot fabricate a GFM table", () => {
    // A pipe line followed by a delimiter-shaped line (here split by <br>) would
    // otherwise parse as a GFM table header+delimiter — pasted prose must remain a
    // paragraph. escapeInline must escape `|` (mirroring escapeCell) to prevent it.
    const md = htmlToMarkdown("<p>h1 | h2<br>:-|:-</p>");
    expect(md).toBe("h1 \\| h2\\\n:-\\|:-");
    // Behavioural pin against Quoll's shipped GFM parser: no Table node forms.
    expect(md).not.toBeNull();
    expect(formsGfmTable(md as string)).toBe(false);
  });
  it("percent-encodes a link destination containing angle brackets", () => {
    // isAllowedUrl accepts the raw href (scheme-only check, no normalisation), so a
    // `<`/`>`-bearing allowed URL reaches markdownDestination's encode branch; the
    // bytes must be percent-encoded so they cannot terminate the destination early.
    const md = htmlToMarkdown('<p><a href="https://x.com/a<b>c">t</a></p>');
    expect(md).toBe("[t](https://x.com/a%3Cb%3Ec)");
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
  it("angle-brackets a link destination containing a space", () => {
    const md = htmlToMarkdown('<p><a href="https://x.com/a b">t</a></p>');
    expect(md).toBe("[t](<https://x.com/a b>)");
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
  it("percent-encodes AND angle-wraps a destination with both a space and angle brackets", () => {
    // The combined case: `<`/`>` are percent-encoded, then the residual space
    // still forces the angle-bracket form — exercises markdownDestination's
    // `<${enc}>` sub-branch (distinct from the bare-encoded and no-encode paths).
    const md = htmlToMarkdown('<p><a href="https://x.com/a b<c>d">t</a></p>');
    expect(md).toBe("[t](<https://x.com/a b%3Cc%3Ed>)");
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
  it("escapes a blockquote `>` marker at a line start", () => {
    expect(htmlToMarkdown("<p>> not a quote</p>")).toBe("\\> not a quote");
  });
  it("escapes a `+` bullet marker at a line start", () => {
    expect(htmlToMarkdown("<p>+ not a bullet</p>")).toBe("\\+ not a bullet");
  });
  it("escapes an ordered-list marker smuggled onto a line after <br>", () => {
    // Pins escapeMarkers' ordered-marker regex on the multiline (post-<br>) path,
    // distinct from the `-`/`#` single-line cases already covered.
    expect(htmlToMarkdown("<p>a<br>1. b</p>")).toBe("a\\\n1\\. b");
  });
  it("returns null (never throws) on pathologically deep inline nesting", () => {
    const deep = `${"<b>".repeat(300)}x${"</b>".repeat(300)}`;
    expect(htmlToMarkdown(deep)).toBeNull();
  });
  it("produces output the host write-gate accepts", () => {
    const md = htmlToMarkdown('<p><a href="javascript:alert(1)">x</a> a|b ---</p>');
    expect(md).not.toBeNull();
    expect(validateMarkdownForWrite(`${md}\n`).ok).toBe(true);
  });
});

describe("htmlToMarkdown — block constructs", () => {
  it("converts headings h1..h6", () => {
    expect(htmlToMarkdown("<h1>A</h1><h3>B</h3>")).toBe("# A\n\n### B");
  });
  it("separates paragraphs with a blank line", () => {
    expect(htmlToMarkdown("<p>a</p><p>b</p>")).toBe("a\n\nb");
  });
  it("converts an unordered list", () => {
    expect(htmlToMarkdown("<ul><li>a</li><li>b</li></ul>")).toBe("- a\n- b");
  });
  it("converts an ordered list honouring start", () => {
    expect(htmlToMarkdown('<ol start="2"><li>a</li><li>b</li></ol>')).toBe("2. a\n3. b");
  });
  it("clamps a negative start to 0 (a valid ordinal, not `-3.`)", () => {
    // `-3.` is not a list marker → the item would degrade to a paragraph.
    expect(htmlToMarkdown('<ol start="-3"><li>a</li><li>b</li></ol>')).toBe("0. a\n1. b");
  });
  it("clamps an oversized start to the 9-digit ListMark ceiling", () => {
    // A 10+-digit ordinal stops being a ListMark; clamp to MAX_LIST_NUMBER and do
    // not let the increment carry it past the ceiling either.
    expect(htmlToMarkdown('<ol start="99999999999"><li>a</li><li>b</li></ol>')).toBe(
      "999999999. a\n999999999. b"
    );
  });
  it("falls back to 1 for a malformed (non-numeric) start", () => {
    expect(htmlToMarkdown('<ol start="abc"><li>a</li><li>b</li></ol>')).toBe("1. a\n2. b");
  });
  it("pins a clamped ordinal as a real ListMark (negative and oversized starts)", () => {
    // Behavioural pin: the clamped marker must parse to an OrderedList under the
    // shipped GFM parser — string equality alone would not catch a future clamp or
    // parser change that quietly stopped producing a valid ListMark.
    const neg = htmlToMarkdown('<ol start="-3"><li>a</li><li>b</li></ol>') as string;
    expect(parsesToNode(neg, "OrderedList")).toBe(true);
    const big = htmlToMarkdown('<ol start="99999999999"><li>a</li><li>b</li></ol>') as string;
    expect(parsesToNode(big, "OrderedList")).toBe(true);
  });
  it("nests lists tightly with marker-width indentation", () => {
    expect(htmlToMarkdown("<ul><li>a<ul><li>b</li></ul></li></ul>")).toBe("- a\n  - b");
  });
  it("unwraps a single <p> inside a list item", () => {
    expect(htmlToMarkdown("<ul><li><p>a</p></li></ul>")).toBe("- a");
  });
  it("keeps two paragraphs in a list item as an indented loose item", () => {
    expect(htmlToMarkdown("<ul><li><p>a</p><p>b</p></li></ul>")).toBe("- a\n\n  b");
  });
  it("renders a code block inside a list item (not flattened to inline code)", () => {
    expect(htmlToMarkdown("<ul><li><pre><code>x</code></pre></li></ul>")).toBe("- ```\n  x\n  ```");
  });
  it("renders a blockquote inside a list item", () => {
    expect(htmlToMarkdown("<ul><li><blockquote>q</blockquote></li></ul>")).toBe("- > q");
  });
  it("converts a fenced code block from <pre>, content unescaped", () => {
    expect(htmlToMarkdown("<pre><code>a*b\nc</code></pre>")).toBe("```\na*b\nc\n```");
  });
  it("extracts a code fence language from a language- class", () => {
    expect(htmlToMarkdown('<pre><code class="language-ts">x</code></pre>')).toBe("```ts\nx\n```");
  });
  it("ignores a malformed / unsafe code-fence language token", () => {
    expect(htmlToMarkdown('<pre><code class="language-a`b c">x</code></pre>')).toBe("```\nx\n```");
  });
  it("uses a longer fence when <pre> content contains a backtick fence", () => {
    expect(htmlToMarkdown("<pre>```\nx\n```</pre>")).toBe("````\n```\nx\n```\n````");
  });
  it("converts a blockquote with two paragraphs", () => {
    expect(htmlToMarkdown("<blockquote><p>a</p><p>b</p></blockquote>")).toBe("> a\n>\n> b");
  });
  it("converts <hr> to a thematic break", () => {
    expect(htmlToMarkdown("<p>a</p><hr><p>b</p>")).toBe("a\n\n---\n\nb");
  });
  it("escapes block-start markers so prose stays literal", () => {
    expect(htmlToMarkdown("<p>- not a bullet</p>")).toBe("\\- not a bullet");
    expect(htmlToMarkdown("<p># not a heading</p>")).toBe("\\# not a heading");
    expect(htmlToMarkdown("<p>1. not a list</p>")).toBe("1\\. not a list");
  });
  it("composes prose + table (reuses the table converter)", () => {
    const md = htmlToMarkdown("<p>intro</p><table><tr><td>A</td><td>B</td></tr></table>");
    expect(md).toBe("intro\n\n| A | B |\n| --- | --- |");
  });
  it("defers the WHOLE fragment (null) when a table in a mixed fragment breaches its cap", () => {
    // The table exceeds the table converter's row cap → tableElementToGfm returns
    // null → the whole conversion aborts so plain-text paste preserves everything
    // (table + prose), rather than silently dropping the table.
    const bigTable = `<table>${"<tr><td>a</td></tr>".repeat(5001)}</table>`;
    expect(htmlToMarkdown(`<p>intro</p>${bigTable}`)).toBeNull();
  });
  it("returns null for an empty / whitespace-only fragment", () => {
    expect(htmlToMarkdown("<p>   </p>")).toBeNull();
    expect(htmlToMarkdown("")).toBeNull();
  });
  it("returns null when the input exceeds the size cap", () => {
    expect(htmlToMarkdown(`<p>${"a".repeat(2 * 1024 * 1024 + 1)}</p>`)).toBeNull();
  });
  it("returns null when the node cap is breached (never throws)", () => {
    const deep = `${"<div>".repeat(60_000)}x${"</div>".repeat(60_000)}`;
    expect(htmlToMarkdown(deep)).toBeNull();
  });
  it("returns null when the block depth cap is breached", () => {
    const nested = `${"<blockquote>".repeat(200)}x${"</blockquote>".repeat(200)}`;
    expect(htmlToMarkdown(nested)).toBeNull();
  });
  it("returns null when table colspan expansion blows the output cap (small input, huge output)", () => {
    // Each table expands to ~1000 columns of GFM (~a few KB); ~2000 of them
    // exceed MAX_OUTPUT_CHARS while the INPUT stays well under the 2 MiB input cap
    // and the node count under MAX_NODES. The incremental output counter must
    // abort mid-build and return null (not build gigabytes then check).
    const oneTable = '<table><tr><td colspan="1000">x</td></tr></table>';
    expect(htmlToMarkdown(oneTable.repeat(2000))).toBeNull();
  });
});
