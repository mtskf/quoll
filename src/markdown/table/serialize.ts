// Inverse of parse.ts. With an unmodified model, `serializeTable` is
// text-identical to the source slice the model was parsed from
// (including CRLF terminators — NEVER `lines.join("\n")`, which
// silently normalizes CRLF -> LF). After a `cell.raw` mutation,
// padding (leadingSpace / trailingSpace / trailingLineSpace) and
// lineEnding are preserved so the diff is a single splice on that cell.

import type { DelimiterRow, Row, Table } from "./model.js";

export function serializeTable(table: Table): string {
  let out = "";
  out += serializeRow(table.header) + table.header.lineEnding;
  out += serializeDelimiterRow(table.delimiter) + table.delimiter.lineEnding;
  for (const row of table.rows) {
    out += serializeRow(row) + row.lineEnding;
  }
  return out;
}

function serializeRow(row: Row): string {
  let out = row.leadingPipe ? "|" : "";
  for (let i = 0; i < row.cells.length; i++) {
    const c = row.cells[i];
    if (i > 0) {
      out += "|";
    }
    out += c.leadingSpace + c.raw + c.trailingSpace;
  }
  if (row.trailingPipe) {
    out += "|";
  }
  out += row.trailingLineSpace;
  return out;
}

function serializeDelimiterRow(row: DelimiterRow): string {
  let out = row.leadingPipe ? "|" : "";
  for (let i = 0; i < row.cells.length; i++) {
    if (i > 0) {
      out += "|";
    }
    out += row.cells[i].raw;
  }
  if (row.trailingPipe) {
    out += "|";
  }
  out += row.trailingLineSpace;
  return out;
}
