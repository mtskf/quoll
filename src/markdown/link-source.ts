// Build link source without letting label punctuation close the link early or
// letting Markdown escapes and entities change the destination.
import { gfmParser } from "./gfm-parser.js";
import { encodeMarkdownDestination } from "./url-decode.js";

// Label nodes whose bytes are kept as written: rewriting `\`, `[` or `]` inside
// them would change what they mean. Every other `\`, `[` and `]` is written as a
// numeric reference, so a nested link, a reference `[x][ref]` or a bare URL
// ending in `]` reads as text.
const labelSourceNodes = new Set([
  // Code spans, autolinks and raw HTML bind tighter than link brackets, and a
  // backslash inside them is literal.
  "InlineCode",
  "Autolink",
  "HTMLTag",
  "Comment",
  "ProcessingInstruction",
  // Already an escape; only an escaped `\`, `[` or `]` is rewritten (below).
  "Escape",
  // A backslash hard break; rewriting the backslash turns it into text.
  "HardBreak",
]);

// An image's own syntax (`![`, `](`, `)`, destination, title) is kept; its alt
// text is walked like any other label text so a `[x]` in it cannot close the link.
const imageSyntaxNodes = new Set(["LinkMark", "URL", "LinkTitle", "LinkLabel"]);

// A numeric reference, not a backslash escape: the GFM autolink of a bare URL
// absorbs a backslash into itself, so `\]` after a URL still ends the URL at the
// `]`. A reference reads as the same character in every context.
function escapeBrackets(text: string): string {
  return text.replace(/[\\[\]]/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Parse the label after an escaped `[`, as the link will: a line start such as
// four spaces, `~~~` or `<div>` is then not read as a block that hides the code
// spans inside it, and the character before the label is the `[` it will follow
// in the link, which emphasis flanking depends on.
const labelPrefix = "\\[";

function escapeLabel(label: string): string {
  const input = labelPrefix + label;
  let escaped = "";
  let plainFrom = labelPrefix.length;
  // A full, synchronous parse keeps the escaping deterministic.
  gfmParser.parse(input).iterate({
    enter: (node) => {
      if (node.from < plainFrom) {
        return;
      }
      const parent = node.node.parent?.name;
      if (
        labelSourceNodes.has(node.name) ||
        (parent === "Image" && imageSyntaxNodes.has(node.name))
      ) {
        escaped += escapeBrackets(input.slice(plainFrom, node.from));
        const bytes = input.slice(node.from, node.to);
        // An escaped `\`, `[` or `]` is rewritten too: a bare URL before it would
        // absorb its backslash.
        escaped +=
          node.name === "Escape" && /[\\[\]]$/.test(bytes) ? escapeBrackets(bytes.slice(1)) : bytes;
        plainFrom = node.to;
        return false;
      }
    },
  });
  return escaped + escapeBrackets(input.slice(plainFrom));
}

export function markdownLinkSource(label: string, href: string): string {
  return `[${escapeLabel(label)}](${encodeMarkdownDestination(href)})`;
}
