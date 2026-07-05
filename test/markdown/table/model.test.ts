import { describe, expect, it } from "vitest";
import type { CellRaw, DelimiterRow, Row } from "../../../src/markdown/table/model.js";
import { makeTable } from "../../../src/markdown/table/model.js";

/** A content row with `cellCount` single-space-padded cells. */
function row(cellCount: number): Row {
  return {
    cells: Array.from({ length: cellCount }, () => ({
      raw: "x" as CellRaw,
      leadingSpace: " ",
      trailingSpace: " ",
      from: 0,
      to: 0,
    })),
    leadingPipe: true,
    trailingPipe: true,
    leadingIndent: "",
    trailingLineSpace: "",
    lineEnding: "\n",
    from: 0,
    to: 0,
  };
}

/** A delimiter row with `cellCount` `---` markers. */
function delimiterRow(cellCount: number): DelimiterRow {
  return {
    cells: Array.from({ length: cellCount }, () => ({ raw: " --- " })),
    leadingPipe: true,
    trailingPipe: true,
    leadingIndent: "",
    trailingLineSpace: "",
    lineEnding: "",
    from: 0,
    to: 0,
  };
}

describe("makeTable", () => {
  it("throws when the header has more cells than the delimiter", () => {
    expect(() => makeTable(row(2), delimiterRow(1), [], 0, 0)).toThrow(/cell-count mismatch/);
  });

  it("throws when the delimiter has more cells than the header", () => {
    // Pins the guard as `!==`, not a one-directional `>` that would miss this.
    expect(() => makeTable(row(1), delimiterRow(2), [], 0, 0)).toThrow(/cell-count mismatch/);
  });

  it("constructs a Table when header and delimiter cell counts match", () => {
    const table = makeTable(row(2), delimiterRow(2), [], 0, 10);
    expect(table.header.cells.length).toBe(2);
    expect(table.delimiter.cells.length).toBe(2);
    expect(table.from).toBe(0);
    expect(table.to).toBe(10);
  });

  it("does not constrain body rows to the header/delimiter cell count", () => {
    // GFM/Lezer never reconciles ragged body rows — makeTable must not either.
    expect(() => makeTable(row(2), delimiterRow(2), [row(1), row(3)], 0, 0)).not.toThrow();
  });
});
