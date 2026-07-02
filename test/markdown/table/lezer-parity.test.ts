// test/markdown/table/lezer-parity.test.ts
// Acceptance gate: for every table-bearing fixture, each non-empty
// cell's [from, to) span must match what @lezer/markdown's GFM parser
// emits as a TableCell. Drift = silent data corruption at the row-split
// boundary, so we pin it here instead of waiting for C6b to catch it
// downstream.
//
// Caveats (ALL verified empirically against the @lezer/markdown version
// pinned in package.json — re-verify when the pin changes):
//
// 1. Lezer's parseRow does NOT emit TableCell nodes for empty cells, so
//    we compare against C6a's non-empty cells only.
//
// 2. Lezer does NOT recognize a table whose lines are terminated with
//    CRLF — the entire block falls through as Paragraph and zero
//    TableCell nodes are emitted. Including the CRLF fixture in this
//    parity corpus would FAIL the test as a spurious drift report.
//
// 3. Lezer also does NOT recognize a table whose rows have trailing
//    whitespace after the final `|` (e.g. `| Alice | Author |  \n`) —
//    same symptom as caveat 2: the block falls through as Paragraph, zero
//    TableCell nodes are emitted. table-trailing-line-ws is therefore also
//    excluded from this corpus.
//
//    Both caveat-2 and caveat-3 fixtures are covered by:
//      (a) dedicated parser/serializer unit tests in parse.test.ts and
//          serialize.test.ts (trailingLineSpace / CRLF describe blocks),
//      (b) the round-trip fixture corpus in round-trip.test.ts, which uses
//          C6a's own findTableRanges + parseTable — NOT Lezer.
//    The hand-rolled splitter + serializer is parity-gated on clean LF
//    inputs; CRLF and trailing-space handling are strict supersets of that
//    behavior, so coverage stays complete.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { parseAllTables } from "../../../src/markdown/table/parse.js";
import { loadFixtures } from "../load-fixtures.js";

// 8 fixtures — same as round-trip.test.ts MINUS gfm-table-crlf (caveat 2)
// and MINUS table-trailing-line-ws (caveat 3).
const LEZER_PARITY_FIXTURES = [
  "gfm-table",
  "table-alignment",
  "inline-pipes-in-code",
  "table-in-cell-link",
  "table-in-cell-image",
  "table-multi-backslash",
  "table-empty-cells",
  "table-1col-pipeless-body",
];

const PARSER = markdown({ base: markdownLanguage }).language.parser;

interface LezerCellRange {
  from: number;
  to: number;
}

function lezerTableCellRanges(source: string): LezerCellRange[] {
  const tree = PARSER.parse(source);
  const cells: LezerCellRange[] = [];
  const cursor = tree.cursor();
  do {
    if (cursor.name === "TableCell") {
      cells.push({ from: cursor.from, to: cursor.to });
    }
  } while (cursor.next());
  return cells;
}

describe("c6a Lezer cell-boundary parity", () => {
  const fixtures = loadFixtures();
  const byName = new Map(fixtures.map((f) => [f.name, f]));

  for (const name of LEZER_PARITY_FIXTURES) {
    it(`${name}: every non-empty C6a cell matches a Lezer TableCell range`, () => {
      const fixture = byName.get(name);
      expect(fixture).toBeDefined();
      if (!fixture) {
        return;
      }

      const lezerCells = lezerTableCellRanges(fixture.source);
      const c6aCells: LezerCellRange[] = [];
      for (const table of parseAllTables(fixture.source)) {
        const headerNonEmpty = table.header.cells.filter((c) => c.raw.length > 0);
        for (const c of headerNonEmpty) {
          c6aCells.push({ from: c.from, to: c.to });
        }
        for (const row of table.rows) {
          for (const c of row.cells) {
            if (c.raw.length > 0) {
              c6aCells.push({ from: c.from, to: c.to });
            }
          }
        }
      }

      // Order-agnostic compare with a single toEqual so a drift report
      // localizes the offending cell range instead of just `true !== false`.
      const sortedC6a = c6aCells.map((c) => `${c.from}..${c.to}`).sort();
      const sortedLezer = lezerCells.map((c) => `${c.from}..${c.to}`).sort();
      expect(sortedC6a).toEqual(sortedLezer);
    });
  }
});
