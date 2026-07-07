import { FENCE_LINE } from "../../../markdown/frontmatter.js";
import { type ScannedLine, scanLines } from "./line-scan.js";

// Offset where body content begins after a file-leading YAML frontmatter block,
// or 0 when the document has none. The lint engine slices this prefix off before
// parsing so frontmatter YAML never lints as Markdown (markdownlint excludes
// front matter by default; without this a `# comment` line parses as an
// ATXHeading, and trailing spaces / double blanks inside the block get flagged).
//
// Detection mirrors the host write-gate and the webview widget detector: opener
// at doc start, close at the first subsequent bare `---` line — single-sourced on
// the `FENCE_LINE` predicate. Line splitting is delegated to `scanLines`, so
// LF / CRLF / lone-CR are handled uniformly and the returned offset lands on the
// first byte AFTER the closer's line terminator. No closer → not frontmatter per
// CommonMark (a leading `---` is a thematic break + prose), so we return 0 and the
// whole document lints normally.
export function leadingFrontmatterBodyStart(raw: string): number {
  const lines = scanLines(raw);
  const opener = lines[0];
  // Need an opener line and at least a closer line below it. (`scanLines` always
  // appends a terminator-less EOF entry, so `length < 2` means opener-only.)
  if (lines.length < 2 || opener === undefined || !FENCE_LINE.test(opener.content)) {
    return 0;
  }
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (line !== undefined && FENCE_LINE.test(line.content)) {
      // Closer at line n. Body starts at the following line's first byte, or at
      // end-of-text when the closer is the last line (empty body after it).
      const next = lines[n + 1];
      return next ? next.from : raw.length;
    }
  }
  return 0; // no closer → not frontmatter
}

// The content lines of a file-leading YAML frontmatter block: the lines STRICTLY
// BETWEEN the opener (line 0) and the first subsequent `---` fence line. `block`
// is the sliced leading frontmatter (`raw.slice(0, leadingFrontmatterBodyStart)`)
// and starts at document offset 0, so each returned line's `from` is already an
// absolute document offset. Returns `[]` when the block has no closer or no
// content between the fences. This confines all fence (`FENCE_LINE`) knowledge to
// this module so the frontmatter lint RULE stays free of any `src/markdown/`
// import — it receives only content lines to classify.
export function frontmatterContentLines(block: string): ScannedLine[] {
  const lines = scanLines(block);
  for (let n = 1; n < lines.length; n++) {
    const line = lines[n];
    if (line !== undefined && FENCE_LINE.test(line.content)) {
      return lines.slice(1, n); // strictly between opener (0) and closer (n)
    }
  }
  return []; // no closer in the block
}
