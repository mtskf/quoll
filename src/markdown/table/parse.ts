// src/markdown/table/parse.ts
import { findTableRanges } from "./find.js";
import type {
  Cell,
  CellRaw,
  DelimiterCell,
  DelimiterRow,
  LineEnding,
  Row,
  Table,
} from "./model.js";
import { alignFromRaw, makeTable } from "./model.js";

/**
 * Parse the substring `source.slice(from, to)` as a GFM table.
 * Returns `null` if the slice is not a well-formed table (missing
 * delimiter row, malformed alignment markers, header/delimiter cell
 * count mismatch, fewer than 2 lines, etc.). Spans on the returned
 * model are absolute document offsets (UTF-16 code units).
 *
 * The slice MUST NOT include a trailing `\n` past the last row;
 * `Table.to === source.indexOf("\n") of the last row, or the slice end`.
 *
 * Body rows are NOT padded or truncated — they reflect the source's
 * actual cell count, which may differ from `delimiter.cells.length`
 * (GFM/Lezer does not reconcile body rows either).
 *
 * Leading whitespace (spaces/tabs) before a row's first pipe/content is
 * captured per-row as `leadingIndent` and skipped, so an indented continuation
 * row (a list-nested or 1-3-space-indented table — Lezer keeps that indent in
 * the node slice) parses as a table. NOTE: called directly this makes the
 * recognizer accept a 4-space (code-block-shaped) indent too; in production
 * Lezer gates table-hood at the tree level and never passes such a slice here.
 */
export function parseTable(source: string, from: number, to: number): Table | null {
  const slice = source.slice(from, to);
  const lineRanges = splitLines(slice, from); // {text, from, to} per line, EXCLUDING `\n`
  if (lineRanges.length < 2) {
    return null;
  }

  const header = parseContentRow(lineRanges[0]);
  const delimiter = parseDelimiterRow(lineRanges[1]);
  if (!delimiter) {
    return null;
  }

  // Header/delimiter mismatch → not a GFM table (matches @lezer/markdown's
  // TableParser, which only promotes the leaf when firstCount === delimCount).
  if (header.cells.length !== delimiter.cells.length) {
    return null;
  }

  const rows: Row[] = [];
  for (let i = 2; i < lineRanges.length; i++) {
    rows.push(parseContentRow(lineRanges[i]));
  }

  return makeTable(
    header,
    delimiter,
    rows,
    header.from,
    (rows.length > 0 ? rows[rows.length - 1] : delimiter).to
  );
}

interface LineRange {
  /** Content of the line WITHOUT its terminator (`\r\n` or `\n` stripped). */
  text: string;
  from: number;
  /** Exclusive offset just past the last byte of `text` (i.e. just before the terminator, or slice end). */
  to: number;
  /** The terminator that followed this line: `"\r\n"`, `"\n"`, or `""` for the slice's last line. */
  lineEnding: LineEnding;
}

// Splits on `\n` AND on `\r\n`. The `\r` is never included in `text` —
// the row splitter would otherwise treat it as cell content and the
// serializer would silently normalize CRLF to LF, breaking Quoll's
// existing CRLF disk-byte-identity contract.
function splitLines(slice: string, baseOffset: number): LineRange[] {
  const out: LineRange[] = [];
  let lineStart = 0;
  for (let i = 0; i < slice.length; i++) {
    if (slice.charCodeAt(i) === 10 /* \n */) {
      const hasCR = i > lineStart && slice.charCodeAt(i - 1) === 13;
      const textEnd = hasCR ? i - 1 : i;
      out.push({
        text: slice.slice(lineStart, textEnd),
        from: baseOffset + lineStart,
        to: baseOffset + textEnd,
        lineEnding: hasCR ? "\r\n" : "\n",
      });
      lineStart = i + 1;
    }
  }
  if (lineStart < slice.length) {
    out.push({
      text: slice.slice(lineStart),
      from: baseOffset + lineStart,
      to: baseOffset + slice.length,
      lineEnding: "",
    });
  }
  return out;
}

// True if text[idx] is preceded by an odd number of backslashes (i.e.
// itself escaped). Used to keep the trailing-`|` check from misfiring
// on `... y\|` (cell content).
function escapeAt(text: string, idx: number): boolean {
  let count = 0;
  for (let j = idx - 1; j >= 0 && text.charCodeAt(j) === 92; j--) {
    count++;
  }
  return count % 2 === 1;
}

function parseContentRow(line: LineRange): Row {
  const { text, from } = line;

  // 1. Capture trailing-line whitespace (spaces/tabs only, NEVER the
  //    body's last `|`) so `| x | y |  ` round-trips verbatim.
  let lineBodyEnd = text.length;
  while (lineBodyEnd > 0) {
    const ch = text.charCodeAt(lineBodyEnd - 1);
    if (ch === 32 || ch === 9) {
      lineBodyEnd--;
    } else {
      break;
    }
  }
  const trailingLineSpace = text.slice(lineBodyEnd);

  const cells: Cell[] = [];
  let leadingPipe = false;
  let trailingPipe = false;

  // Capture leading indentation (spaces/tabs) before the row's first pipe or
  // content. Non-empty for a list-nested table's continuation rows, where Lezer
  // retains the indent in the Table node slice. Skipping it here (rather than
  // letting it bleed into cell[0]) keeps the leading-pipe row from spawning a
  // phantom empty first cell; it is re-emitted verbatim by serializeRow.
  let indentEnd = 0;
  while (indentEnd < lineBodyEnd) {
    const ch = text.charCodeAt(indentEnd);
    if (ch === 32 || ch === 9) {
      indentEnd++;
    } else {
      break;
    }
  }
  const leadingIndent = text.slice(0, indentEnd);

  let i = indentEnd;
  if (text.charCodeAt(i) === 124 /* | */) {
    leadingPipe = true;
    i++;
  }

  let cellStart = -1;
  let cellEnd = -1;
  let paddingStart = i; // index just after the leading indent + optional `|`
  let esc = false;

  const pushCell = (sepIndex: number) => {
    const leadingSpace =
      cellStart === -1 ? text.slice(paddingStart, sepIndex) : text.slice(paddingStart, cellStart);
    const trailingSpace = cellStart === -1 ? "" : text.slice(cellEnd, sepIndex);
    // The `as CellRaw` cast is sound: the [cellStart, cellEnd) slice cannot
    // enclose an unescaped `|`. The esc-tracking scan only advances `cellEnd`
    // past a `|` when it was escaped (preceded by an odd number of `\`); an
    // unescaped `|` is consumed as a cell separator, never as content. So the
    // verbatim slice already satisfies the `CellRaw` escaped-pipe invariant.
    const cellRaw = (cellStart === -1 ? "" : text.slice(cellStart, cellEnd)) as CellRaw;
    const contentFrom = cellStart === -1 ? from + sepIndex : from + cellStart;
    const contentTo = cellStart === -1 ? from + sepIndex : from + cellEnd;
    cells.push({
      raw: cellRaw,
      leadingSpace,
      trailingSpace,
      from: contentFrom,
      to: contentTo,
    });
  };

  for (; i < lineBodyEnd; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 124 /* | */ && !esc) {
      pushCell(i);
      cellStart = -1;
      cellEnd = -1;
      paddingStart = i + 1;
    } else if (esc || (ch !== 32 /* space */ && ch !== 9) /* tab */) {
      if (cellStart < 0) {
        cellStart = i;
      }
      cellEnd = i + 1;
    }
    esc = !esc && ch === 92 /* \\ */;
  }

  // Tail: did the row body end with an unescaped `|`?
  if (
    lineBodyEnd > 0 &&
    text.charCodeAt(lineBodyEnd - 1) === 124 &&
    !escapeAt(text, lineBodyEnd - 1)
  ) {
    trailingPipe = true;
    // (final `|` was already consumed as a separator by the loop)
  } else if (paddingStart < lineBodyEnd || cellStart > -1) {
    pushCell(lineBodyEnd);
  }

  return {
    cells,
    leadingPipe,
    trailingPipe,
    leadingIndent,
    trailingLineSpace,
    lineEnding: line.lineEnding,
    from: line.from,
    to: line.to,
  };
}

function parseDelimiterRow(line: LineRange): DelimiterRow | null {
  const { text, from } = line;

  // Same trailing-line-whitespace handling as content rows.
  let lineBodyEnd = text.length;
  while (lineBodyEnd > 0) {
    const ch = text.charCodeAt(lineBodyEnd - 1);
    if (ch === 32 || ch === 9) {
      lineBodyEnd--;
    } else {
      break;
    }
  }
  const trailingLineSpace = text.slice(lineBodyEnd);

  let leadingPipe = false;
  let trailingPipe = false;

  // See parseContentRow: capture and skip leading indentation so an indented
  // delimiter line (`  |---|---|`, a list-nested continuation) is not misread
  // as a first cell whose raw is the whitespace prefix.
  let indentEnd = 0;
  while (indentEnd < lineBodyEnd) {
    const ch = text.charCodeAt(indentEnd);
    if (ch === 32 || ch === 9) {
      indentEnd++;
    } else {
      break;
    }
  }
  const leadingIndent = text.slice(0, indentEnd);

  let i = indentEnd;
  if (text.charCodeAt(i) === 124) {
    leadingPipe = true;
    i++;
  }

  const cells: DelimiterCell[] = [];
  let cellRawStart = i;

  const pushDelimiterCell = (sepIndex: number): boolean => {
    const raw = text.slice(cellRawStart, sepIndex);
    // `alignFromRaw` doubles as the validity gate: `undefined` means `raw` is
    // not a delimiter marker, so the leaf is not a GFM table.
    if (alignFromRaw(raw) === undefined) {
      return false;
    }
    cells.push({ raw });
    return true;
  };

  for (; i < lineBodyEnd; i++) {
    if (text.charCodeAt(i) === 124) {
      if (!pushDelimiterCell(i)) {
        return null;
      }
      cellRawStart = i + 1;
    }
  }
  if (lineBodyEnd > 0 && text.charCodeAt(lineBodyEnd - 1) === 124) {
    trailingPipe = true;
  } else if (cellRawStart < lineBodyEnd) {
    if (!pushDelimiterCell(lineBodyEnd)) {
      return null;
    }
  }

  if (cells.length === 0) {
    return null;
  }

  return {
    cells,
    leadingPipe,
    trailingPipe,
    leadingIndent,
    trailingLineSpace,
    lineEnding: line.lineEnding,
    from,
    to: line.to,
  };
}

/**
 * Test-only convenience: find every table block in `source` and parse
 * each. Production consumers receive ranges from a Lezer-tree walk
 * (C6b) and call `parseTable` directly. Skips ranges where `parseTable`
 * returns `null` (malformed delimiter row, etc.).
 */
export function parseAllTables(source: string): Table[] {
  const out: Table[] = [];
  for (const { from, to } of findTableRanges(source)) {
    const t = parseTable(source, from, to);
    if (t) {
      out.push(t);
    }
  }
  return out;
}
