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
  // A backslash hard break; doubling the backslash turns it into text.
  "HardBreak",
]);

// An image's own syntax (`![`, `](`, `)`, destination, title) is kept; its alt
// text is walked like any other label text so a `[x]` in it cannot close the link.
const imageSyntaxNodes = new Set(["LinkMark", "URL", "LinkTitle", "LinkLabel"]);

// A bare URL absorbs a backslash escape into itself, so `\]` would still end the
// URL at the `]`. A numeric reference keeps the character literal and reads as
// the same text.
function entityEscapeUrl(url: string): string {
  return url.replace(/[\\[\]]/g, (c) => `&#${c.charCodeAt(0)};`);
}

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
  // A full, synchronous parse keeps the escaping deterministic.
  gfmParser.parse(input).iterate({
    enter: (node) => {
      if (node.from < plainFrom) {
        return;
      }
      const parent = node.node.parent?.name;
      const keep =
        labelSourceNodes.has(node.name) || (parent === "Image" && imageSyntaxNodes.has(node.name));
      const bareUrl = node.name === "URL" && parent !== "Image" && parent !== "Link";
      if (keep || bareUrl) {
        escaped += escapePlainText(input.slice(plainFrom, node.from));
        const bytes = input.slice(node.from, node.to);
        escaped += keep ? bytes : entityEscapeUrl(bytes);
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
