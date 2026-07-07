import { parseTable } from "../../../../markdown/table/index.js";
import { collectTableRanges } from "../../table/table-ranges.js";
import type { LintContext, LintDiagnostic, LintRule } from "../types.js";

// Flag a GFM table BODY row whose cell count differs from the delimiter row's.
// The table block widget renders each row's cells as-is: a short row leaves its
// trailing column(s) blank (so it looks plausibly correct), while an overflow row
// extends the grid with extra columns. Either way the row is ragged in source —
// this lint surfaces each mismatched row in the Problems panel, where a short
// row's defect is otherwise invisible in the rendered grid.
//
// Table detection reuses `collectTableRanges` (the ONE Lezer `Table`-node walk the
// block widget consumes) and `parseTable` (the same pure GFM model the widget
// renders), so lint, render, and structural ops never drift on what a "table" or a
// "row" is. `parseTable` guarantees `header.cells.length === delimiter.cells.length`
// (it returns null otherwise — a header/delimiter mismatch is not a GFM table at
// all, so Lezer never forms a `Table` node for it either), so only BODY rows can be
// ragged in a parsed table; the header is compared implicitly via the delimiter.
//
// A pipeless line that follows a table with no blank separator is a LEGITIMATE
// 1-cell body row per GFM (spec §4.10, example 206) — NOT a Lezer overshoot to trim
// (see memory quoll-lezer-table-to-overshoots-trailing-line). It is counted like any
// row, so a genuinely ragged trailing line is correctly flagged.
//
// `parseTable` returns null for a `Table` node it cannot model (a blockquote-nested
// table whose continuation lines carry `>` markers); such nodes are skipped rather
// than mis-attributed. Advisory only (severity "warning", no autofix): a ragged row
// still renders, so it is a hygiene hint, not a write-blocking failure.
export const tableColumnCount: LintRule = (ctx: LintContext): LintDiagnostic[] => {
  const diagnostics: LintDiagnostic[] = [];
  for (const range of collectTableRanges(ctx.tree)) {
    const table = parseTable(ctx.text, range.from, range.to);
    if (!table) {
      continue; // Table node parseTable cannot model (e.g. blockquote-nested)
    }
    const expected = table.delimiter.cells.length;
    for (const row of table.rows) {
      const actual = row.cells.length;
      if (actual !== expected) {
        diagnostics.push({
          from: row.from,
          to: row.to,
          severity: "warning",
          code: "table-column-count",
          message: `Table row has ${actual} cell${actual === 1 ? "" : "s"} but the table defines ${expected} column${expected === 1 ? "" : "s"} (per the delimiter row).`,
        });
      }
    }
  }
  return diagnostics;
};
