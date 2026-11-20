// Build link source without letting label punctuation close the link early or
// letting Markdown escapes and entities change the destination.
import { gfmParser } from "./gfm-parser.js";
import { encodeMarkdownDestination } from "./url-decode.js";

// Label nodes whose bytes are kept as written: escaping `\`, `[` or `]` inside
// them would change what they mean. Every other `\`, `[` and `]` is escaped, so
// a nested link, a reference `[x][ref]` or a bare URL ending in `]` reads as text.
const labelSourceNodes = new Set([
  // Code spans, autolinks and raw HTML bind tighter than link brackets, and a
  // backslash inside them is literal.
  "InlineCode",
  "Autolink",
  "HTMLTag",
  "Comment",
  "ProcessingInstruction",
  // Already an escape; escaping its backslash would expose the escaped mark.
  "Escape",
  // Its brackets are the image syntax, which a link label may contain.
  "Image",
  // A backslash hard break; doubling the backslash turns it into text.
  "HardBreak",
]);

function escapePlainText(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
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
  // A full, synchronous parse of just the label keeps the escaping deterministic.
  gfmParser.parse(input).iterate({
    enter: (node) => {
      if (node.from >= plainFrom && labelSourceNodes.has(node.name)) {
        escaped += escapePlainText(input.slice(plainFrom, node.from));
        escaped += input.slice(node.from, node.to);
        plainFrom = node.to;
        return false;
      }
    },
  });
  return escaped + escapePlainText(input.slice(plainFrom));
}

export function markdownLinkSource(label: string, href: string): string {
  return `[${escapeLabel(label)}](${encodeMarkdownDestination(href)})`;
}
