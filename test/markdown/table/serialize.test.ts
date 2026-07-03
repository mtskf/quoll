import { describe, expect, it } from "vitest";
import { toCellRaw } from "../../../src/markdown/table/model.js";
import { parseTable } from "../../../src/markdown/table/parse.js";
import { serializeTable } from "../../../src/markdown/table/serialize.js";

describe("serializeTable", () => {
  it("round-trips a basic table byte-for-byte", () => {
    const tableText = "| Name | Role |\n| ---- | ---- |\n| Alice | Author |";
    const t = parseTable(tableText, 0, tableText.length);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(serializeTable(t)).toBe(tableText);
  });
});

describe("serializeTable with edited cells", () => {
  it("preserves leading/trailing whitespace when a cell's raw changes", () => {
    const tableText = "| Name  | Role     |\n| ----- | -------- |\n| Alice | Author   |";
    const t = parseTable(tableText, 0, tableText.length);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    // Edit the first body cell raw only.
    t.rows[0].cells[0] = { ...t.rows[0].cells[0], raw: toCellRaw("Carol") };
    expect(serializeTable(t)).toBe(
      "| Name  | Role     |\n| ----- | -------- |\n| Carol | Author   |"
    );
  });

  it("preserves the alignment marker byte-for-byte under cell edits", () => {
    const tableText = "| A | B |\n| :--- | ----: |\n| x | y |";
    const t = parseTable(tableText, 0, tableText.length);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    t.rows[0].cells[0] = { ...t.rows[0].cells[0], raw: toCellRaw("X") };
    expect(serializeTable(t)).toBe("| A | B |\n| :--- | ----: |\n| X | y |");
  });

  it("preserves trailingLineSpace on unedited rows", () => {
    const tableText = "| A | B |  \n| - | - |\n| x | y |";
    const t = parseTable(tableText, 0, tableText.length);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(serializeTable(t)).toBe(tableText);
  });

  it("round-trips CRLF line endings verbatim", () => {
    // Slice the table without the trailing \r\n past the last row.
    const tableText = "| A | B |\r\n| - | - |\r\n| 1 | 2 |";
    const t = parseTable(tableText, 0, tableText.length);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(serializeTable(t)).toBe(tableText);
    // The serialized output MUST contain \r\n, not just \n.
    expect(serializeTable(t)).toContain("\r\n");
  });

  it("round-trips an edited cell while preserving CRLF terminators", () => {
    const tableText = "| A | B |\r\n| - | - |\r\n| 1 | 2 |";
    const t = parseTable(tableText, 0, tableText.length);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    t.rows[0].cells[0] = { ...t.rows[0].cells[0], raw: toCellRaw("X") };
    expect(serializeTable(t)).toBe("| A | B |\r\n| - | - |\r\n| X | 2 |");
  });

  it("escapes | and \\ in edited cell content, serializing as valid GFM", () => {
    const tableText = "| A |\n| - |\n| x |";
    const t = parseTable(tableText, 0, tableText.length);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    t.rows[0].cells[0] = { ...t.rows[0].cells[0], raw: toCellRaw("a\\|b") };
    expect(serializeTable(t)).toBe("| A |\n| - |\n| a\\\\\\|b |");
  });
});

describe("serializeTable — indented continuation round-trip", () => {
  it.each([
    ["list/2-space", "| A | B |\n  |---|---|\n  | 1 | 2 |"],
    ["tab", "| A | B |\n\t|---|---|\n\t| 1 | 2 |"],
    ["top-level 3-space", "| A | B |\n   |---|---|\n   | 1 | 2 |"],
    ["CRLF list-nested", "| A | B |\r\n  |---|---|\r\n  | 1 | 2 |"],
  ])("round-trips a %s indented table byte-for-byte", (_label, slice) => {
    const t = parseTable(slice, 0, slice.length);
    if (!t) {
      throw new Error("expected a table");
    }
    expect(serializeTable(t)).toBe(slice);
  });
});
