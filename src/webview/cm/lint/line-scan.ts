// A single line of the raw document: its content with the terminator stripped,
// the absolute offset of its first character, and whether a line terminator
// followed it (false only for the final line at EOF).
export type ScannedLine = {
  readonly content: string;
  readonly from: number;
  readonly terminated: boolean;
};

// Split the raw text into lines with their absolute start offset, EXCLUDING the
// line terminator from each line's content. Handles LF / CRLF / lone-CR
// uniformly (a manual scan rather than `split("\n")`, which would leave a
// trailing "\r" on CRLF lines and hide real trailing whitespace). `lintMarkdown`
// is a raw-Markdown contract — a future host mirror may see CRLF even though the
// live webview is LF-internal — so EOL-robustness belongs here, shared by every
// line-oriented rule. ALWAYS appends a final terminator-less entry for the EOF
// line (which is empty when the document ends with a newline); line-oriented
// rules that care about that phantom must account for it.
export function scanLines(text: string): ScannedLine[] {
  const lines: ScannedLine[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\n" || ch === "\r") {
      lines.push({ content: text.slice(from, i), from, terminated: true });
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1; // consume CRLF as one terminator
      from = i;
    } else {
      i += 1;
    }
  }
  lines.push({ content: text.slice(from), from, terminated: false }); // final line (no terminator)
  return lines;
}
