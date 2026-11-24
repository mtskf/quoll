// Single-pass line planner: ONE per-line decision covers both trailing-whitespace
// trim and blank-line collapse, so the two rules can never emit overlapping edits.
// A line intersecting a keep-out range (protected block or table) is skipped
// entirely — by INTERSECTION, so a region starting mid-line still protects the
// whole line. Trim is hard-break-preserving (a content line whose trailing run
// ENDS with >= 2 spaces becomes exactly two spaces — the CommonMark hard break;
// every other trailing run — one space, or one ending in a tab, or a
// whitespace-only line — is trimmed to empty). Two exceptions keep the trim from
// changing what the line renders: a line end inside a multi-line literal span
// (inline code, raw HTML, link title) is left alone, because that whitespace is
// content; and a run that would trim to empty after an odd number of
// backslashes becomes one space, because a bare trailing `\` is a hard break.
// Blank collapse reduces a run of >= 3 blank lines to a single blank line; a
// keep-out line ends a blank run, and a line deleted by collapse is excluded
// from the trim pass.
import type { Edit } from "./edit.js";
import type { Range } from "./segment.js";

type LineRecord = {
  start: number;
  contentEnd: number; // after the last non-terminator char (before \r?\n)
  termStart: number; // start of the \r?\n terminator (=== termEnd on a final line)
  termEnd: number; // after the terminator
};

function splitLines(source: string): LineRecord[] {
  const lines: LineRecord[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") {
      const termEnd = i + 1;
      let contentEnd = i;
      let termStart = i;
      if (contentEnd > start && source[contentEnd - 1] === "\r") {
        termStart = i - 1;
        contentEnd = i - 1;
      }
      lines.push({ start, contentEnd, termStart, termEnd });
      start = termEnd;
    }
  }
  // Final line without a terminator (also the sole record for an empty source).
  if (start < source.length || lines.length === 0) {
    lines.push({
      start,
      contentEnd: source.length,
      termStart: source.length,
      termEnd: source.length,
    });
  }
  return lines;
}

// Start of the trailing whitespace run within a line's content [start, contentEnd).
function trailingWsStart(source: string, line: LineRecord): number {
  let ws = line.contentEnd;
  while (ws > line.start) {
    const ch = source[ws - 1];
    if (ch === " " || ch === "\t") {
      ws -= 1;
    } else {
      break;
    }
  }
  return ws;
}

// True when the content before `end` ends with an odd number of backslashes,
// i.e. its last backslash is not itself escaped.
function endsWithUnescapedBackslash(source: string, from: number, end: number): boolean {
  let i = end;
  while (i > from && source[i - 1] === "\\") {
    i -= 1;
  }
  return (end - i) % 2 === 1;
}

// Per-line "intersects a keep-out range" flags. keepOut may be unsorted and
// overlapping (protected blocks + tables), so it is sorted by `from` once and
// walked with one forward cursor: line starts only grow, so a range ending at
// or before this line's start can never touch a later line. A per-line `.some`
// rescan was O(lines x ranges) — seconds on a document with ~20k small tables.
function keepOutMask(lines: readonly LineRecord[], keepOut: readonly Range[]): boolean[] {
  const ranges = [...keepOut].sort((a, b) => a.from - b.from);
  let next = 0;
  return lines.map((line) => {
    while (next < ranges.length && ranges[next].to <= line.start) {
      next += 1;
    }
    // Every later range starts at or after this one, so if this one starts past
    // the line, none can reach it.
    const head = ranges[next];
    return head !== undefined && head.from < line.termEnd;
  });
}

export function lineEdits(
  source: string,
  keepOut: readonly Range[],
  literalSpans: readonly Range[]
): Edit[] {
  const lines = splitLines(source);
  const skipped = keepOutMask(lines, keepOut);
  const deleted = new Array<boolean>(lines.length).fill(false);
  const edits: Edit[] = [];

  // Blank collapse: scan maximal runs of consecutive blank (non-skipped) lines.
  // A skipped line terminates a run (keep-out boundaries never merge blanks).
  let runStart = -1;
  const flushRun = (endExclusive: number): void => {
    if (runStart < 0) {
      return;
    }
    const n = endExclusive - runStart;
    if (n >= 3) {
      const first = lines[runStart];
      const last = lines[endExclusive - 1];
      edits.push({ from: first.termEnd, to: last.termEnd, insert: "" });
      for (let k = runStart + 1; k < endExclusive; k++) {
        deleted[k] = true;
      }
    }
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const wsStart = trailingWsStart(source, lines[i]);
    const isBlank = !skipped[i] && wsStart === lines[i].start;
    if (isBlank) {
      if (runStart < 0) {
        runStart = i;
      }
    } else {
      flushRun(i);
    }
  }
  flushRun(lines.length);

  // Trailing trim: one decision per non-skipped, non-deleted line.
  // literalSpans arrive in source order and disjoint (classifyDocument does not
  // descend into a literal node), and wsStart only grows down the document, so
  // one forward cursor replaces a per-line rescan (which was quadratic).
  let literalIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    if (skipped[i] || deleted[i]) {
      continue;
    }
    const line = lines[i];
    const wsStart = trailingWsStart(source, line);
    if (wsStart === line.contentEnd) {
      continue; // no trailing whitespace at all
    }
    while (literalIndex < literalSpans.length && literalSpans[literalIndex].to <= wsStart) {
      literalIndex += 1;
    }
    const literal = literalSpans[literalIndex];
    if (literal && literal.from < line.termEnd) {
      continue; // the run (or the line end itself) is literal content
    }
    const run = source.slice(wsStart, line.contentEnd);
    // Content line whose trailing run ENDS with >= 2 spaces => hard break (two
    // spaces); after an unescaped backslash => one space (keeps it literal);
    // everything else (single space, a run ending in a tab, or a whitespace-only
    // line) trims to empty.
    let target = "";
    if (wsStart > line.start && / {2}$/.test(run)) {
      target = "  ";
    } else if (endsWithUnescapedBackslash(source, line.start, wsStart)) {
      target = " ";
    }
    if (target !== run) {
      edits.push({ from: wsStart, to: line.contentEnd, insert: target });
    }
  }

  return edits;
}
