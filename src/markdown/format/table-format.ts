// Reformat GFM tables to padded, alignment-aware normal form using the pure
// table model. Table ranges come from the Lezer classifier (parser authority),
// already filtered against protected regions. A table is skipped (byte-
// untouched) when parseTable rejects it, its header lacks an outer pipe, it has
// a single column (the Lezer Table.to overshoot — a trailing line absorbed as a
// phantom row — corrupts ONLY 1-column tables), or it is ragged (any body row's
// cell count != column count). A false-skip is always safe.
import { type Align, type Table, parseTable, tableAlign } from "../table/index.js";
import type { Edit } from "./edit.js";
import type { Range } from "./segment.js";

const MIN_WIDTH = 3;
const display = (raw: string): string => raw.trim();

function pad(text: string, width: number, align: Align | undefined): string {
  const gap = Math.max(0, width - text.length);
  if (align === "right") {
    return " ".repeat(gap) + text;
  }
  if (align === "center") {
    const left = Math.floor(gap / 2);
    return " ".repeat(left) + text + " ".repeat(gap - left);
  }
  return text + " ".repeat(gap);
}

function delimiterCell(width: number, align: Align | undefined): string {
  if (align === "center") {
    return `:${"-".repeat(Math.max(1, width - 2))}:`;
  }
  if (align === "left") {
    return `:${"-".repeat(Math.max(1, width - 1))}`;
  }
  if (align === "right") {
    return `${"-".repeat(Math.max(1, width - 1))}:`;
  }
  return "-".repeat(width);
}

export function formatTableBlock(table: Table): string {
  const cols = table.delimiter.cells.length;
  const aligns = tableAlign(table);
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = Math.max(MIN_WIDTH, display(table.header.cells[c]?.raw ?? "").length);
    for (const row of table.rows) {
      w = Math.max(w, display(row.cells[c]?.raw ?? "").length);
    }
    widths[c] = w;
  }
  const renderRow = (cells: readonly { raw: string }[], indent: string, ending: string): string =>
    `${indent}| ${widths.map((w, c) => pad(display(cells[c]?.raw ?? ""), w, aligns[c])).join(" | ")} |${ending}`;

  let out = renderRow(table.header.cells, table.header.leadingIndent, table.header.lineEnding);
  out += `${table.delimiter.leadingIndent}| ${widths.map((w, c) => delimiterCell(w, aligns[c])).join(" | ")} |${table.delimiter.lineEnding}`;
  for (const row of table.rows) {
    out += renderRow(row.cells, row.leadingIndent, row.lineEnding);
  }
  return out;
}

export function tableEdits(source: string, tableRanges: readonly Range[]): Edit[] {
  const edits: Edit[] = [];
  for (const { from, to } of tableRanges) {
    const table = parseTable(source, from, to);
    if (!table) {
      continue; // malformed / blockquote table
    }
    // Only reformat "well-formed" tables with both outer pipes. formatTableBlock
    // always emits `| … |`; forcing outer pipes onto a pipe-less-outer table
    // (valid GFM, e.g. `a | b\n:-- | --:\n1 | 2`) is render-identical but changes
    // the Lezer structure signature, so we conservatively leave those untouched.
    if (!table.header.leadingPipe || !table.header.trailingPipe) {
      continue;
    }
    const cols = table.delimiter.cells.length;
    // Overshoot guard = skip 1-column tables. This is the ONE place a Lezer
    // `Table.to` overshoot can corrupt: a 1-column table absorbs ANY non-blank
    // trailing line as a phantom single-cell body row — a plain paragraph, OR
    // one whose only pipe is escaped (`plain \| text`) — which is not ragged and
    // would be rewritten into a table row. Multi-column tables have no such risk
    // (a pipe-less trailing line breaks the table; a short row is ragged-caught
    // below; a genuine extra row is a real GFM row). A 1-column table has no
    // cross-column alignment to gain, so skipping it is conservative with
    // negligible cost — and it eliminates the whole overshoot class (incl. the
    // escaped-pipe edge) without a fragile per-line heuristic.
    if (cols === 1) {
      continue;
    }
    if (table.rows.some((r) => r.cells.length !== cols)) {
      continue; // ragged -> byte-untouched
    }
    const slice = source.slice(from, to);
    const formatted = formatTableBlock(table);
    if (formatted === slice) {
      continue; // already normal form
    }
    edits.push({ from, to, insert: formatted });
  }
  return edits;
}
