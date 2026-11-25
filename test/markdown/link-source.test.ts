import type { SyntaxNode } from "@lezer/common";
import { expect, it } from "vitest";
import { gfmParser } from "../../src/markdown/gfm-parser.js";
import { markdownLinkSource } from "../../src/markdown/link-source.js";
import { decodeMarkdownDestination } from "../../src/markdown/url-decode.js";
import { commonMarkAltText } from "../../src/webview/cm/inline/inline-ir.js";

const href = "https://x.test";

it.each([
  { label: "a]b", href, escapedLabel: "a&#93;b", destination: href, text: "a]b" },
  { label: "foo\\", href, escapedLabel: "foo&#92;", destination: href, text: "foo\\" },
  { label: "\\\\x", href, escapedLabel: "&#92;x", destination: href, text: "\\x" },
  { label: "phase [2", href, escapedLabel: "phase &#91;2", destination: href, text: "phase [2" },
  { label: "[x", href, escapedLabel: "&#91;x", destination: href, text: "[x" },
  { label: "a [b] c", href, escapedLabel: "a &#91;b&#93; c", destination: href, text: "a [b] c" },
  { label: "[x](y)", href, escapedLabel: "&#91;x&#93;(y)", destination: href, text: "[x](y)" },
  { label: "**b]**", href, escapedLabel: "**b&#93;**", destination: href, text: "b]" },
  { label: "`a]b`", href, escapedLabel: "`a]b`", destination: href, text: "a]b" },
  { label: "\\*lit", href, escapedLabel: "\\*lit", destination: href, text: "*lit" },
  {
    label: "[x][y]",
    href,
    escapedLabel: "&#91;x&#93;&#91;y&#93;",
    destination: href,
    text: "[x][y]",
  },
  {
    label: "see [text][ref] now",
    href,
    escapedLabel: "see &#91;text&#93;&#91;ref&#93; now",
    destination: href,
    text: "see [text][ref] now",
  },
  {
    label: "![a]b](i.png)",
    href,
    escapedLabel: "![a]b&#93;(i.png)",
    destination: href,
    text: "![a]b](i.png)",
  },
  { label: "<b>]</b>", href, escapedLabel: "<b>&#93;</b>", destination: href, text: "<b>]</b>" },
  {
    label: "<https://a.test/x>",
    href,
    escapedLabel: "<https://a.test/x>",
    destination: href,
    text: "https://a.test/x",
  },
  { label: "&#93;", href, escapedLabel: "&#93;", destination: href, text: "]" },
  { label: "a\\\nb", href, escapedLabel: "a\\\nb", destination: href, text: "a\\\nb" },
  { label: "    a]b", href, escapedLabel: "    a&#93;b", destination: href, text: "    a]b" },
  { label: "~~~ a]b", href, escapedLabel: "~~~ a&#93;b", destination: href, text: "~~~ a]b" },
  { label: "<div> a]b", href, escapedLabel: "<div> a&#93;b", destination: href, text: "<div> a]b" },
  { label: "    `a]b`", href, escapedLabel: "    `a]b`", destination: href, text: "    a]b" },
  { label: "<div> `a]b`", href, escapedLabel: "<div> `a]b`", destination: href, text: "<div> a]b" },
  {
    label: "![a [b] d](e)",
    href,
    escapedLabel: "![a &#91;b&#93; d](e)",
    destination: href,
    text: "a [b] d",
  },
  {
    label: "![a [b](c) d](e)",
    href,
    escapedLabel: "![a &#91;b&#93;(c) d](e)",
    destination: href,
    text: "a [b](c) d",
  },
  {
    label: "![[x](y)](z)",
    href,
    escapedLabel: "![&#91;x&#93;(y)](z)",
    destination: href,
    text: "[x](y)",
  },
  {
    label: "<!-- a]b -->",
    href,
    escapedLabel: "<!-- a]b -->",
    destination: href,
    text: "<!-- a]b -->",
  },
  { label: "<?x a]b?>", href, escapedLabel: "<?x a]b?>", destination: href, text: "<?x a]b?>" },
  // A bare URL's autolink absorbs a backslash, so brackets after it must not be backslash-escaped.
  {
    label: "https://example.test/path]",
    href,
    escapedLabel: "https://example.test/path&#93;",
    destination: href,
    text: "https://example.test/path]",
  },
  {
    label: "https://x.test/a[b",
    href,
    escapedLabel: "https://x.test/a&#91;b",
    destination: href,
    text: "https://x.test/a[b",
  },
  {
    label: "https://x.test/a\\b",
    href,
    escapedLabel: "https://x.test/a&#92;b",
    destination: href,
    text: "https://x.test/a\\b",
  },
  {
    label: "www.x.test/a]b",
    href,
    escapedLabel: "www.x.test/a&#93;b",
    destination: href,
    text: "www.x.test/a]b",
  },
  {
    label: "[https://x.test/a]",
    href,
    escapedLabel: "&#91;https://x.test/a&#93;",
    destination: href,
    text: "[https://x.test/a]",
  },
  {
    label: "see [https://x.test/a] here",
    href,
    escapedLabel: "see &#91;https://x.test/a&#93; here",
    destination: href,
    text: "see [https://x.test/a] here",
  },
  {
    label: "[https://x.test/a[b]c]",
    href,
    escapedLabel: "&#91;https://x.test/a&#91;b&#93;c&#93;",
    destination: href,
    text: "[https://x.test/a[b]c]",
  },
  {
    label: "[https://x.test/a](d)",
    href,
    escapedLabel: "&#91;https://x.test/a&#93;(d)",
    destination: href,
    text: "[https://x.test/a](d)",
  },
  {
    label: "[www.x.test/a]",
    href,
    escapedLabel: "&#91;www.x.test/a&#93;",
    destination: href,
    text: "[www.x.test/a]",
  },
  {
    label: "[t](https://x.test/a]b)",
    href,
    escapedLabel: "&#91;t&#93;(https://x.test/a&#93;b)",
    destination: href,
    text: "[t](https://x.test/a]b)",
  },
  {
    label: "![[https://x.test/a]](e)",
    href,
    escapedLabel: "![&#91;https://x.test/a&#93;](e)",
    destination: href,
    text: "[https://x.test/a]",
  },
  // A kept `\]` after a bare URL would lose its backslash to the URL.
  {
    label: "[https://x.test/p]\\]",
    href,
    escapedLabel: "&#91;https://x.test/p&#93;&#93;",
    destination: href,
    text: "[https://x.test/p]]",
  },
  {
    label: "[https://x.test/p]\\[",
    href,
    escapedLabel: "&#91;https://x.test/p&#93;&#91;",
    destination: href,
    text: "[https://x.test/p][",
  },
  { label: "a\\[b", href, escapedLabel: "a&#91;b", destination: href, text: "a[b" },
  // Inline image alt is walked: an escaped bracket in it is rewritten.
  {
    label: "![a\\]b](e)",
    href,
    escapedLabel: "![a&#93;b](e)",
    destination: href,
    text: "a]b",
  },
  // A reference image matches its definition by source spelling, so it is kept.
  { label: "![a\\]b]", href, escapedLabel: "![a\\]b]", destination: href, text: "![a]b]" },
  { label: "![a\\]b][]", href, escapedLabel: "![a\\]b][]", destination: href, text: "![a]b][]" },
  { label: "![a][r]", href, escapedLabel: "![a][r]", destination: href, text: "![a][r]" },
  {
    label: "[][https://x.test/p]",
    href,
    escapedLabel: "&#91;&#93;&#91;https://x.test/p&#93;",
    destination: href,
    text: "[][https://x.test/p]",
  },
  {
    label: "label",
    href: "https://x.test/AT&amp;T",
    escapedLabel: "label",
    destination: "https://x.test/AT&amp;amp;T",
    text: "label",
  },
  {
    label: "label",
    href: "https://x.test/a(b",
    escapedLabel: "label",
    destination: "<https://x.test/a(b>",
    text: "label",
  },
  {
    label: "label",
    href: "https://x.test/a)b",
    escapedLabel: "label",
    destination: "<https://x.test/a)b>",
    text: "label",
  },
  {
    label: "label",
    href: "https://x.test/a\\\\b",
    escapedLabel: "label",
    destination: "https://x.test/a&#92;&#92;b",
    text: "label",
  },
])("writes a full link for $label → $href", ({ label, href, escapedLabel, destination, text }) => {
  const source = markdownLinkSource(label, href);
  expect(source).toBe(`[${escapedLabel}](${destination})`);

  const links: SyntaxNode[] = [];
  gfmParser.parse(source).iterate({
    enter: (node) => {
      if (node.name === "Link") {
        links.push(node.node);
      }
    },
  });
  expect(links.map(({ from, to }) => [from, to])).toEqual([[0, source.length]]);
  const url = links[0]?.getChildren("URL").at(-1);
  expect(url).toBeDefined();
  expect(decodeMarkdownDestination(source.slice(url?.from, url?.to))).toBe(href);
  expect(commonMarkAltText(source.slice(1, links[0]?.getChildren("LinkMark")[1]?.from))).toBe(text);
});
