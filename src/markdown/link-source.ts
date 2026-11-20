// Build link source without letting label punctuation close the link early or
// letting Markdown escapes and entities change the destination.
import { gfmParser } from "./gfm-parser.js";
import { encodeMarkdownDestination } from "./url-decode.js";

// Ported verbatim from @codemirror/lang-markdown's built-in pasteURLAsLink: Lezer
// node names that are NOT plain Markdown text (code, an existing link/image,
// emphasis marks, raw HTML, an autolink URL, …). Matched case-insensitively.
export const nonPlainText =
  /code|horizontalrule|html|link|comment|processing|escape|entity|image|mark|url/i;

function preservesLabelSource(name: string): boolean {
  // Lezer reads any [x] as a Link, so its brackets would shadow the outer link.
  return name !== "Link" && name !== "LinkMark" && nonPlainText.test(name);
}

function escapeLabel(label: string): string {
  let escaped = "";
  let plainFrom = 0;
  // A full, synchronous parse of just the label keeps the escaping deterministic.
  gfmParser.parse(label).iterate({
    enter: (node) => {
      if (preservesLabelSource(node.name)) {
        escaped += label.slice(plainFrom, node.from).replace(/[\\[\]]/g, "\\$&");
        escaped += label.slice(node.from, node.to);
        plainFrom = node.to;
        return false;
      }
    },
  });
  return escaped + label.slice(plainFrom).replace(/[\\[\]]/g, "\\$&");
}

export function markdownLinkSource(label: string, href: string): string {
  return `[${escapeLabel(label)}](${encodeMarkdownDestination(href)})`;
}
