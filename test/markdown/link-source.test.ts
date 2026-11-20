import type { SyntaxNode } from "@lezer/common";
import { expect, it } from "vitest";
import { gfmParser } from "../../src/markdown/gfm-parser.js";
import { markdownLinkSource } from "../../src/markdown/link-source.js";
import { decodeMarkdownDestination } from "../../src/markdown/url-decode.js";
import { commonMarkAltText } from "../../src/webview/cm/inline/inline-ir.js";

const href = "https://x.test";

it.each([
  { label: "a]b", href, escapedLabel: "a\\]b", destination: href, text: "a]b" },
  { label: "foo\\", href, escapedLabel: "foo\\\\", destination: href, text: "foo\\" },
  { label: "phase [2", href, escapedLabel: "phase \\[2", destination: href, text: "phase [2" },
  { label: "[x", href, escapedLabel: "\\[x", destination: href, text: "[x" },
  { label: "a [b] c", href, escapedLabel: "a \\[b\\] c", destination: href, text: "a [b] c" },
  { label: "[x](y)", href, escapedLabel: "\\[x\\](y)", destination: href, text: "[x](y)" },
  { label: "**b]**", href, escapedLabel: "**b\\]**", destination: href, text: "b]" },
  { label: "`a]b`", href, escapedLabel: "`a]b`", destination: href, text: "a]b" },
  { label: "\\*lit", href, escapedLabel: "\\*lit", destination: href, text: "*lit" },
  { label: "[x][y]", href, escapedLabel: "\\[x\\]\\[y\\]", destination: href, text: "[x][y]" },
  {
    label: "see [text][ref] now",
    href,
    escapedLabel: "see \\[text\\]\\[ref\\] now",
    destination: href,
    text: "see [text][ref] now",
  },
  {
    label: "![a]b](i.png)",
    href,
    escapedLabel: "![a]b\\](i.png)",
    destination: href,
    text: "![a]b](i.png)",
  },
  { label: "<b>]</b>", href, escapedLabel: "<b>\\]</b>", destination: href, text: "<b>]</b>" },
  {
    label: "<https://a.test/x>",
    href,
    escapedLabel: "<https://a.test/x>",
    destination: href,
    text: "https://a.test/x",
  },
  { label: "&#93;", href, escapedLabel: "&#93;", destination: href, text: "]" },
  { label: "a\\\nb", href, escapedLabel: "a\\\nb", destination: href, text: "a\\\nb" },
  { label: "    a]b", href, escapedLabel: "    a\\]b", destination: href, text: "    a]b" },
  { label: "~~~ a]b", href, escapedLabel: "~~~ a\\]b", destination: href, text: "~~~ a]b" },
  { label: "<div> a]b", href, escapedLabel: "<div> a\\]b", destination: href, text: "<div> a]b" },
  { label: "    `a]b`", href, escapedLabel: "    `a]b`", destination: href, text: "    a]b" },
  { label: "<div> `a]b`", href, escapedLabel: "<div> `a]b`", destination: href, text: "<div> a]b" },
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
    destination: "https://x.test/a\\\\\\\\b",
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
  const url = links[0]?.getChild("URL");
  expect(url).toBeDefined();
  expect(decodeMarkdownDestination(source.slice(url?.from, url?.to))).toBe(href);
  expect(commonMarkAltText(source.slice(1, links[0]?.getChildren("LinkMark")[1]?.from))).toBe(text);
});
