// src/markdown/table/structure.ts
// Pure row/column structure transforms over the C6a Table model (C6d PR1).
// Each function returns a NEW Table; serializeTable turns it back into
// Markdown. Spans (from/to) are NOT maintained — serializeTable ignores
// them and the result is for re-serialization only, never slot mapping.
//
// EOL invariant: in a parsed Table every line carries a real terminator
// EXCEPT the final one (the Table node has no trailing newline), whose
// lineEnding is "". Structure ops preserve that invariant by shuffling the
// terminator across the new boundary. New rows copy the source's
// leading/trailing-pipe convention from the header so a pipeless table
// stays pipeless.

import type { Align, Cell, CellRaw, DelimiterCell, LineEnding, Row, Table } from "./model.js";
import { makeTable } from "./model.js";

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/** The terminator used BETWEEN rows. The header is never the last line (a
 *  delimiter always follows), so its lineEnding is a real terminator — the
 *  table's canonical EOL. Defensive fallback to "\n". */
function interiorEol(table: Table): Exclude<LineEnding, ""> {
  return table.header.lineEnding === "" ? "\n" : table.header.lineEnding;
}

/** A blank content cell with single-space GFM-canonical padding. */
function emptyCell(): Cell {
  return { raw: "" as CellRaw, leadingSpace: " ", trailingSpace: " ", from: 0, to: 0 };
}

/** A blank delimiter cell whose marker encodes `align`. The surrounding
 *  spaces match the `| --- |` house style serializeDelimiterRow expects in
 *  `raw` (it adds no padding of its own). */
function delimiterCellFor(align: Align): DelimiterCell {
  const raw =
    align === "center"
      ? " :---: "
      : align === "left"
        ? " :--- "
        : align === "right"
          ? " ---: "
          : " --- ";
  return { raw };
}

function makeEmptyRow(colCount: number, table: Table, lineEnding: LineEnding): Row {
  return {
    cells: Array.from({ length: colCount }, emptyCell),
    leadingPipe: table.header.leadingPipe,
    trailingPipe: table.header.trailingPipe,
    trailingLineSpace: "",
    lineEnding,
    from: 0,
    to: 0,
  };
}

/** A pipeless row whose last cell is empty (or which has zero cells) is
 *  ambiguous: serialized it ends in "| <whitespace>" and parseTable re-reads
 *  the trailing `|` as a trailingPipe (dropping the cell), or a 0-cell row
 *  serializes to "" and splits the table. Give such a row bounding pipes so
 *  the empty trailing cell is explicit and the table round-trips. Rows that
 *  are already piped, or whose last cell is non-empty, are returned unchanged
 *  (pipeless style is preserved wherever it stays unambiguous). */
function disambiguateRow(row: Row): Row {
  if (row.trailingPipe) {
    return row;
  }
  const last = row.cells[row.cells.length - 1];
  if (last !== undefined && last.raw.trim() !== "") {
    return row;
  }
  return { ...row, leadingPipe: true, trailingPipe: true };
}

/** Apply {@link disambiguateRow} to the header and every body row (NOT the
 *  delimiter, whose cells are never empty). Run at the end of every op that
 *  can leave a row with an empty trailing cell or zero cells. */
function disambiguate(table: Table): Table {
  // disambiguateRow only flips leading/trailing pipes, never cell counts, so
  // this preserves the input invariant — but route through makeTable anyway so
  // the SHARED exit path of every structure op is a validated construction, not
  // a bare spread that a future disambiguateRow touching cells could corrupt.
  return makeTable(
    disambiguateRow(table.header),
    table.delimiter,
    table.rows.map(disambiguateRow),
    table.from,
    table.to
  );
}

export function insertRow(table: Table, at: number): Table {
  const eol = interiorEol(table);
  const colCount = table.header.cells.length;
  const rows = [...table.rows];
  const idx = clamp(at, 0, rows.length);

  if (idx >= rows.length) {
    // Append after the current last line: that line gains the EOL, the new
    // row becomes the last line (no terminator).
    const newRow = makeEmptyRow(colCount, table, "");
    if (rows.length > 0) {
      rows[rows.length - 1] = { ...rows[rows.length - 1], lineEnding: eol };
      rows.push(newRow);
      return disambiguate({ ...table, rows });
    }
    // Header-only table: the delimiter is the last line and must gain the EOL.
    return disambiguate({
      ...table,
      delimiter: { ...table.delimiter, lineEnding: eol },
      rows: [newRow],
    });
  }

  rows.splice(idx, 0, makeEmptyRow(colCount, table, eol));
  return disambiguate({ ...table, rows });
}

export function deleteRow(table: Table, at: number): Table {
  if (at < 0 || at >= table.rows.length) {
    return table; // out of range → no-op
  }
  const rows = [...table.rows];
  const wasLast = at === rows.length - 1;
  rows.splice(at, 1);
  if (wasLast) {
    if (rows.length > 0) {
      // New last row loses its terminator.
      rows[rows.length - 1] = { ...rows[rows.length - 1], lineEnding: "" };
    } else {
      // No body rows left: the delimiter becomes the last line.
      return { ...table, delimiter: { ...table.delimiter, lineEnding: "" }, rows };
    }
  }
  return { ...table, rows };
}

export function insertColumn(table: Table, at: number, align: Align = null): Table {
  const headerCells = [...table.header.cells];
  headerCells.splice(clamp(at, 0, headerCells.length), 0, emptyCell());

  const delimCells = [...table.delimiter.cells];
  delimCells.splice(clamp(at, 0, delimCells.length), 0, delimiterCellFor(align));

  const rows = table.rows.map((row) => {
    const cells = [...row.cells];
    // Ragged rows: clamp to this row's own length so a short row gets the new
    // cell appended at its end rather than a hole.
    cells.splice(clamp(at, 0, cells.length), 0, emptyCell());
    return { ...row, cells };
  });

  return disambiguate(
    makeTable(
      { ...table.header, cells: headerCells },
      { ...table.delimiter, cells: delimCells },
      rows,
      table.from,
      table.to
    )
  );
}

export function deleteColumn(table: Table, at: number): Table {
  const colCount = table.header.cells.length;
  if (at < 0 || at >= colCount || colCount <= 1) {
    return table; // out of range, or never delete the last column → no-op
  }
  const without = <T>(cells: readonly T[], i: number): T[] => {
    const c = [...cells];
    if (i < c.length) {
      c.splice(i, 1);
    }
    return c;
  };
  const delimCells = without(table.delimiter.cells, at);
  return disambiguate(
    makeTable(
      { ...table.header, cells: without(table.header.cells, at) },
      { ...table.delimiter, cells: delimCells },
      table.rows.map((row) => ({ ...row, cells: without(row.cells, at) })),
      table.from,
      table.to
    )
  );
}
