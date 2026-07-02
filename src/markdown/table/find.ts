// src/markdown/table/find.ts
// Pure line sweep used INTERNALLY by parseAllTables. Not re-exported
// from the barrel — production consumers receive table ranges from
// C6b's Lezer-tree walk, NOT from this regex.
// Acceptance: test/markdown/table/lezer-parity.test.ts pins that the
// ranges this finder produces over the fixture corpus equal what
// Lezer's GFM parser emits.

// A table block per GFM = a content line, a delimiter line, then >= 0 more content lines.
// We detect by scanning lines and looking for a header + delimiter pair, then
// extending the body. Continuation predicate:
//   - multi-column tables: only lines that contain an unescaped `|`.
//   - 1-column tables (delimiter cell count === 1, per GFM §4.10): also
//     lines that have no `|` but are non-blank, e.g. `| A |\n| - |\nbody\n`.
// A blank / whitespace-only line always terminates the body.
// For multi-column tables, any line lacking an unescaped `|` also terminates.
// Most block-level interrupters (ATX headings without inline pipes, list items
// without inline pipes, fenced code fences) happen to have no pipe and so
// break the body without special detection, BUT interrupter lines that do
// contain a pipe (e.g. `# h | x` or `- foo | bar`) are still absorbed as
// body rows. For 1-column tables (allowPipelessBody), termination is
// blank-only: any non-blank line — including all interrupters — is absorbed.
// Fixtures in the parity corpus must avoid such cases after 1-column table
// headers, and also avoid pipe-bearing interrupters after any header.

const DELIMITER_LINE = /^\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?\s*$/;

export interface TableRange {
  from: number;
  to: number;
}

export function findTableRanges(source: string): TableRange[] {
  // Split on `\n` for offset-stable line indexing, then strip any
  // trailing `\r` from each line's *test text* (CRLF documents must
  // not break the delimiter regex). The lineStarts offsets are still
  // computed from the raw (CR-bearing) split so the returned ranges
  // are correct against the original source.
  const rawLines = source.split("\n");
  const lines = rawLines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const lineStarts: number[] = [0];
  for (let i = 0, off = 0; i < rawLines.length; i++) {
    off += rawLines[i].length + 1;
    lineStarts.push(off);
  }

  const ranges: TableRange[] = [];
  let i = 0;
  while (i < lines.length - 1) {
    const header = lines[i];
    const delim = lines[i + 1];
    if (hasUnescapedPipe(header) && DELIMITER_LINE.test(delim)) {
      const allowPipelessBody = delimiterCellCount(delim) === 1;
      let last = i + 1;
      let j = i + 2;
      while (j < lines.length) {
        const line = lines[j];
        if (hasUnescapedPipe(line)) {
          last = j;
          j++;
        } else if (allowPipelessBody && hasNonWhitespace(line)) {
          last = j;
          j++;
        } else {
          break;
        }
      }
      // The range ends just before the line terminator of `last` (matches
      // the parser's "slice up to but not including the trailing newline"
      // contract). Use lines[last].length (CR-stripped) so the range stops
      // at the last `|`, not the `\r`.
      ranges.push({
        from: lineStarts[i],
        to: lineStarts[last] + lines[last].length,
      });
      i = last + 1;
    } else {
      i++;
    }
  }
  return ranges;
}

function hasUnescapedPipe(line: string): boolean {
  let esc = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 124 && !esc) {
      return true;
    }
    esc = !esc && ch === 92;
  }
  return false;
}

function hasNonWhitespace(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch !== 32 /* space */ && ch !== 9 /* tab */) {
      return true;
    }
  }
  return false;
}

// Count cell specs in a delimiter row that already passed DELIMITER_LINE.
// The regex disallows `\`, so we don't need to track escapes here. The
// leading and trailing pipes are optional per GFM, hence the conditional
// strips before counting interior separators.
function delimiterCellCount(line: string): number {
  let end = line.length;
  while (end > 0) {
    const ch = line.charCodeAt(end - 1);
    if (ch === 32 || ch === 9) {
      end--;
    } else {
      break;
    }
  }
  let start = 0;
  if (start < end && line.charCodeAt(start) === 124) {
    start++;
  }
  if (end > start && line.charCodeAt(end - 1) === 124) {
    end--;
  }
  let count = 1;
  for (let k = start; k < end; k++) {
    if (line.charCodeAt(k) === 124) {
      count++;
    }
  }
  return count;
}
