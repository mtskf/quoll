// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { validateMarkdownForWrite } from "../../../src/markdown/validate-for-write.js";
import { htmlToMarkdown } from "../../../src/webview/cm/paste/html-to-markdown.js";

describe("htmlToMarkdown — inline constructs", () => {
  it("converts bold (<strong> and <b>)", () => {
    expect(htmlToMarkdown("<p><strong>a</strong> <b>c</b></p>")).toBe("**a** **c**");
  });
  it("converts italic (<em> and <i>)", () => {
    expect(htmlToMarkdown("<p><em>a</em> <i>c</i></p>")).toBe("*a* *c*");
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
