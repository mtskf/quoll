import { describe, expect, it } from "vitest";
import { parseTable } from "../../../src/markdown/table/parse.js";
import { serializeTable } from "../../../src/markdown/table/serialize.js";
import {
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
} from "../../../src/markdown/table/structure.js";

/** Parse a table source slice; fail loudly if it is not a table. */
function parse(src: string) {
  const t = parseTable(src, 0, src.length);
  if (t === null) {
    throw new Error("fixture is not a table");
  }
  return t;
}

/** Re-parse a serialized structure-op result and assert it is still a
 *  well-formed table whose header / delimiter cell counts agree. This is the
 *  invariant the byte-exact `toBe(...)` assertions alone cannot catch: a
 *  pipeless row that ends in an empty cell serializes ambiguously and
 *  parseTable then drops the cell (or splits the table on an empty line). */
function roundTrips(out: string): boolean {
  const t = parseTable(out, 0, out.length);
  return t !== null && t.header.cells.length === t.delimiter.cells.length;
}

const BASIC = `| Name | Role |
| ---- | ---- |
| Alice | Author |
| Bob | Editor |`;

describe("insertRow", () => {
  it("inserts an empty body row below the first row (one new line, others intact)", () => {
    const out = serializeTable(insertRow(parse(BASIC), 1));
    expect(out).toBe(`| Name | Role |
| ---- | ---- |
| Alice | Author |
|  |  |
| Bob | Editor |`);
  });

  it("appends a row at the end: previous last row gains the EOL, new row is last", () => {
    const out = serializeTable(insertRow(parse(BASIC), 2));
    expect(out).toBe(`| Name | Role |
| ---- | ---- |
| Alice | Author |
| Bob | Editor |
|  |  |`);
  });

  it("appends the first body row to a header-only table (delimiter gains the EOL)", () => {
    const headerOnly = `| A | B |
| - | - |`;
    const out = serializeTable(insertRow(parse(headerOnly), 0));
    expect(out).toBe(`| A | B |
| - | - |
|  |  |`);
  });
});

describe("deleteRow", () => {
  it("deletes a middle body row", () => {
    const out = serializeTable(deleteRow(parse(BASIC), 0));
    expect(out).toBe(`| Name | Role |
| ---- | ---- |
| Bob | Editor |`);
  });

  it("deletes the last body row: new last row loses its EOL", () => {
    const out = serializeTable(deleteRow(parse(BASIC), 1));
    expect(out).toBe(`| Name | Role |
| ---- | ---- |
| Alice | Author |`);
  });

  it("deletes the only body row: delimiter becomes the last line", () => {
    const oneBody = `| A | B |
| - | - |
| 1 | 2 |`;
    const out = serializeTable(deleteRow(parse(oneBody), 0));
    expect(out).toBe(`| A | B |
| - | - |`);
  });

  it("is a no-op for an out-of-range index", () => {
    expect(serializeTable(deleteRow(parse(BASIC), 9))).toBe(BASIC);
  });
});

describe("insertColumn", () => {
  it("inserts a column on the right, preserving existing alignment", () => {
    const aligned = `| A | B |
| :-- | --: |
| 1 | 2 |`;
    const out = serializeTable(insertColumn(parse(aligned), 2, null));
    expect(out).toBe(`| A | B |  |
| :-- | --: | --- |
| 1 | 2 |  |`);
  });

  it("inserts a centre-aligned column in the middle", () => {
    const out = serializeTable(insertColumn(parse(BASIC), 1, "center"));
    expect(out).toBe(`| Name |  | Role |
| ---- | :---: | ---- |
| Alice |  | Author |
| Bob |  | Editor |`);
  });

  it("appends the new cell to a ragged (short) body row without leaving a hole", () => {
    // Body row has 1 cell; header/delimiter have 2. Insert at col 2.
    const ragged = `| A | B |
| - | - |
| 1 |`;
    const out = serializeTable(insertColumn(parse(ragged), 2, null));
    expect(out).toBe(`| A | B |  |
| - | - | --- |
| 1 |  |`);
  });
});

describe("deleteColumn", () => {
  it("deletes a column from header, delimiter, and every body row, preserving remaining alignment", () => {
    const aligned = `| A | B | C |
| :-- | :-: | --: |
| 1 | 2 | 3 |`;
    const out = serializeTable(deleteColumn(parse(aligned), 1));
    expect(out).toBe(`| A | C |
| :-- | --: |
| 1 | 3 |`);
  });

  it("is a no-op when only one column remains", () => {
    const oneCol = `| A |
| - |
| 1 |`;
    expect(serializeTable(deleteColumn(parse(oneCol), 0))).toBe(oneCol);
  });

  it("is a no-op for an out-of-range index", () => {
    expect(serializeTable(deleteColumn(parse(BASIC), 9))).toBe(BASIC);
  });

  it("leaves a ragged (short) body row intact when the deleted column is past its end", () => {
    // Header has 3 cols; the last body row is ragged with a single cell.
    // Deleting col 1 removes it from header/delimiter/full rows; the short row
    // keeps its sole cell (the "no hole" contract — it stays ragged at its own
    // length rather than crashing or shifting).
    const ragged = `| A | B | C |
| - | - | - |
| 1 | 2 | 3 |
| x |`;
    const out = serializeTable(deleteColumn(parse(ragged), 1));
    expect(out).toBe(`| A | C |
| - | - |
| 1 | 3 |
| x |`);
  });
});

describe("CRLF and pipe-style preservation", () => {
  it("inserts a row keeping CRLF terminators on unmodified rows", () => {
    const crlf = "| A | B |\r\n| - | - |\r\n| 1 | 2 |";
    const out = serializeTable(insertRow(parse(crlf), 1));
    expect(out).toBe("| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n|  |  |");
  });

  it("disambiguates a new pipeless row (empty trailing cell gets bounding pipes; existing pipeless rows preserved) and round-trips", () => {
    // A pipeless empty row serializes to "  |  ", where parseTable re-reads the
    // final `|` as a trailingPipe and DROPS the second cell. So the appended
    // empty row alone gets bounding pipes (`|  |  |`), making the empty trailing
    // cell explicit; the existing pipeless content rows are untouched.
    const pipeless = `A | B
- | -
1 | 2`;
    const out = serializeTable(insertRow(parse(pipeless), 1));
    expect(out).toBe(`A | B
- | -
1 | 2
|  |  |`);
    // Without the fix this re-parses to a 1-cell appended row and trips the
    // round-trip invariant.
    expect(roundTrips(out)).toBe(true);
    const reparsed = parse(out);
    expect(reparsed.header.cells.length).toBe(reparsed.delimiter.cells.length);
    expect(reparsed.rows.map((r) => r.cells.length)).toEqual([2, 2]);
  });
});

// Pipeless structure ops are the regression surface for the C6d PR1 CRITICAL
// (insertColumn destroyed the table) and HIGH (deleteColumn split it) bugs: an
// appended/emptied trailing cell on a pipeless row serializes ambiguously. Each
// test re-parses the serialized output — these FAIL against the pre-fix code.
describe("pipeless round-trip (structure ops must stay parseable)", () => {
  it("insertColumn appending a trailing column to a pipeless table round-trips", () => {
    const pipeless = `A | B
- | -
1 | 2`;
    const out = serializeTable(insertColumn(parse(pipeless), 2, null));
    // Pre-fix: the new empty trailing cell makes header/body rows serialize to
    // "…|  " and parseTable returns null → the table is DESTROYED. `parse`
    // throws on null, so this fails loudly against the pre-fix code.
    expect(parseTable(out, 0, out.length)).not.toBeNull();
    const reparsed = parse(out);
    expect(reparsed.header.cells.length).toBe(3);
    expect(reparsed.delimiter.cells.length).toBe(3);
    expect(reparsed.rows.map((r) => r.cells.length)).toEqual([3]);
  });

  it("deleteColumn emptying a ragged pipeless row does not split the table", () => {
    // Pipeless 2-col table whose sole body row is ragged with a single cell.
    // Deleting col 0 empties that body row to zero cells; pre-fix it serializes
    // to "" (an empty line) which splits the table and drops the row.
    const raggedPipeless = `A | B
- | -
1`;
    const out = serializeTable(deleteColumn(parse(raggedPipeless), 0));
    expect(out.split("\n").some((line) => line.trim() === "")).toBe(false);
    expect(parseTable(out, 0, out.length)).not.toBeNull();
    const reparsed = parse(out);
    expect(reparsed.header.cells.length).toBe(reparsed.delimiter.cells.length);
    expect(reparsed.rows.length).toBe(1);
  });
});
