// Single-pass line planner: ONE per-line decision covers both trailing-whitespace
// trim and blank-line collapse, so the two rules can never emit overlapping edits.
// A line intersecting a keep-out range (protected block or table) is skipped
// entirely — by INTERSECTION, so a region starting mid-line still protects the
// whole line. Trim is hard-break-preserving (a content line whose trailing run
// ENDS with >= 2 spaces becomes exactly two spaces — the CommonMark hard break;
// every other trailing run — one space, or one ending in a tab, or a
// whitespace-only line — is trimmed to empty). Blank collapse
// reduces a run of >= 3 blank lines to a single blank line; a keep-out line ends
// a blank run, and a line deleted by collapse is excluded from the trim pass.
import type { Edit } from "./edit.js";
import { type Range, rangesIntersect } from "./segment.js";

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

export function lineEdits(source: string, keepOut: readonly Range[]): Edit[] {
  const lines = splitLines(source);
  const skipped = lines.map((l) => rangesIntersect(keepOut, l.start, l.termEnd));
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
  for (let i = 0; i < lines.length; i++) {
    if (skipped[i] || deleted[i]) {
      continue;
    }
    const line = lines[i];
    const wsStart = trailingWsStart(source, line);
    if (wsStart === line.contentEnd) {
      continue; // no trailing whitespace at all
    }
    const run = source.slice(wsStart, line.contentEnd);
    // Content line whose trailing run ENDS with >= 2 spaces => hard break (two
    // spaces); everything else (single space, a run ending in a tab, or a
    // whitespace-only line) trims to empty.
    const target = wsStart > line.start && / {2}$/.test(run) ? "  " : "";
    if (target !== run) {
      edits.push({ from: wsStart, to: line.contentEnd, insert: target });
    }
  }

  return edits;
}
