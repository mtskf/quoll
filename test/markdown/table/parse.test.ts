// test/markdown/table/parse.test.ts
import { describe, expect, it } from "vitest";
import { tableAlign } from "../../../src/markdown/table/model.js";
import { parseAllTables, parseTable } from "../../../src/markdown/table/parse.js";

describe("parseTable", () => {
  it("parses a 2-column header + 2 body rows with default alignment", () => {
    const source = "| Name | Role |\n| ---- | ---- |\n| Alice | Author |\n| Bob | Reviewer |\n";
    const table = parseTable(source, 0, source.length - 1); // strip trailing \n
    expect(table).not.toBeNull();
    if (!table) {
      return;
    }
    expect(table.header.cells.map((c) => c.raw)).toEqual(["Name", "Role"]);
    expect(tableAlign(table)).toEqual([null, null]);
    expect(table.rows.map((r) => r.cells.map((c) => c.raw))).toEqual([
      ["Alice", "Author"],
      ["Bob", "Reviewer"],
    ]);
  });

  it("rejects when header and delimiter cell counts disagree", () => {
    const source = "| A | B | C |\n| - | - |\n| 1 | 2 | 3 |\n";
    expect(parseTable(source, 0, source.length - 1)).toBeNull();
  });

  it("preserves trailing whitespace after the final pipe (no synthetic empty cell)", () => {
    const source = "| A | B |  \n| - | - |\n| 1 | 2 |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.cells).toHaveLength(2);
    expect(t.header.trailingPipe).toBe(true);
    expect(t.header.trailingLineSpace).toBe("  ");
  });

  it("preserves a body row with FEWER cells than the delimiter (no padding)", () => {
    const source = "| A | B | C |\n| - | - | - |\n| 1 | 2 |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.cells).toHaveLength(3);
    expect(t.rows[0].cells.map((c) => c.raw)).toEqual(["1", "2"]);
  });

  it("preserves a body row with MORE cells than the delimiter (no truncation)", () => {
    const source = "| A | B |\n| - | - |\n| 1 | 2 | 3 |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.cells).toHaveLength(2);
    expect(t.rows[0].cells.map((c) => c.raw)).toEqual(["1", "2", "3"]);
  });
});

describe("parseTable column alignment", () => {
  it("reads :--- / :---: / ---: / --- markers", () => {
    const source = "| A | B | C | D |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t && tableAlign(t)).toEqual(["left", "center", "right", null]);
  });

  it("preserves the raw delimiter padding byte-for-byte", () => {
    const source = "| A | B |\n| :--- | ----: |\n| 1 | 2 |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t?.delimiter.cells.map((c) => c.raw)).toEqual([" :--- ", " ----: "]);
  });

  it("rejects a malformed delimiter row (returns null)", () => {
    const source = "| A | B |\n| ??? | ??? |\n| 1 | 2 |\n";
    expect(parseTable(source, 0, source.length - 1)).toBeNull();
  });
});

describe("parseTable escaping", () => {
  it("treats `\\|` as part of the cell, not a separator", () => {
    const source = "| Pattern | Meaning |\n| ------- | ------- |\n| `a\\|b` | a or b |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t?.rows[0].cells.map((c) => c.raw)).toEqual(["`a\\|b`", "a or b"]);
  });

  it("treats a row-ending `\\|` as cell content, not a trailing pipe", () => {
    const source = "| A | B |\n| - | - |\n| x | y\\|\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t?.rows[0].trailingPipe).toBe(false);
    expect(t?.rows[0].cells[1].raw).toBe("y\\|");
  });

  it("treats `\\\\|` (escaped backslash + unescaped pipe) as a cell separator", () => {
    // `a\\` is one literal backslash; the `|` after is UNescaped.
    // Source bytes: | a\\ | b | i.e. two cells "a\\" and "b".
    const source = "| A | B |\n| - | - |\n| a\\\\ | b |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t?.rows[0].cells.map((c) => c.raw)).toEqual(["a\\\\", "b"]);
  });

  it("treats `\\\\\\|` (escaped backslash + escaped pipe) as cell content", () => {
    // `a\\\|` = one literal backslash + escaped pipe; the `|` is escaped.
    const source = "| A |\n| - |\n| a\\\\\\|b |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t?.rows[0].cells.map((c) => c.raw)).toEqual(["a\\\\\\|b"]);
  });

  it("treats `y\\\\|` at end of row as a trailing pipe (the backslash is escaped, the `|` is not)", () => {
    const source = "| A | B |\n| - | - |\n| x | y\\\\|\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t?.rows[0].trailingPipe).toBe(true);
    expect(t?.rows[0].cells[1].raw).toBe("y\\\\");
  });
});

describe("parseTable span correctness", () => {
  it("reports absolute document offsets for each cell's text content", () => {
    const src = "| Alice | Author |\n| - | - |\n";
    const t = parseTable(src, 0, src.length - 1);
    expect(t?.header.cells[0].from).toBe(src.indexOf("Alice"));
    expect(t?.header.cells[0].to).toBe(src.indexOf("Alice") + 5);
    expect(t?.header.cells[1].from).toBe(src.indexOf("Author"));
    expect(t?.header.cells[1].to).toBe(src.indexOf("Author") + 6);
  });

  it("offsets a parsed slice against the document base offset", () => {
    const prefix = "Heading text.\n\n";
    const tableSrc = "| A | B |\n| - | - |\n| 1 | 2 |";
    const src = `${prefix + tableSrc}\n`;
    const t = parseTable(src, prefix.length, prefix.length + tableSrc.length);
    expect(t?.header.cells[0].from).toBe(src.indexOf("A"));
    expect(t?.rows[0].cells[1].raw).toBe("2");
    expect(t?.rows[0].cells[1].from).toBe(src.indexOf("2"));
  });

  it("reports correct UTF-16 code-unit offsets across CJK fullwidth cells", () => {
    // Each "あ"/"い" etc. is one UTF-16 code unit in JS.
    const source = "| あ | い |\n| - | - |\n| う | え |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t?.header.cells[0].raw).toBe("あ");
    expect(t?.header.cells[0].from).toBe(source.indexOf("あ"));
    expect(t?.header.cells[0].to).toBe(source.indexOf("あ") + 1);
    expect(t?.rows[0].cells[1].raw).toBe("え");
    expect(t?.rows[0].cells[1].from).toBe(source.indexOf("え"));
  });

  it("reports correct UTF-16 offsets for astral (surrogate-pair) characters AND the cell that follows it", () => {
    // "😀" (U+1F600) is 2 UTF-16 code units in JS strings.
    const source = "| 😀 | b |\n| - | - |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.cells[0].raw).toBe("😀");
    expect(t.header.cells[0].from).toBe(source.indexOf("😀"));
    // 2 code units, not 1 — pins the contract that offsets are
    // code-unit-based (UTF-16), not codepoint-based.
    expect(t.header.cells[0].to - t.header.cells[0].from).toBe(2);
    // Pin the FOLLOWING cell's offset too — the real UTF-16 contract is
    // "offsets past an astral char don't drift". `b` must be at its
    // code-unit position in the source, regardless of how the emoji
    // before it is counted.
    expect(t.header.cells[1].from).toBe(source.indexOf("b"));
  });
});

describe("parseTable empty cells", () => {
  it("parses a leading empty cell with raw === '' AND a zero-width span at the next `|`", () => {
    const source = "|     | B |\n| --- | - |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.cells[0].raw).toBe("");
    expect(t.header.cells[1].raw).toBe("B");
    // Zero-width span pin: the empty cell's insertion cursor must land
    // at exactly one position so C6c (editable cells) doesn't drift.
    // For a leading empty cell, that position is the `|` separator after
    // the leading whitespace.
    expect(t.header.cells[0].from).toBe(t.header.cells[0].to);
    expect(t.header.cells[0].from).toBe(source.indexOf("|", 1));
  });

  it("parses a middle empty cell with raw === '' AND a zero-width span at the separator", () => {
    const source = "| A |   | C |\n| - | - | - |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.cells.map((c) => c.raw)).toEqual(["A", "", "C"]);
    expect(t.header.cells[1].from).toBe(t.header.cells[1].to);
    // Middle empty cell sits at the closing `|` of its slot.
    expect(t.header.cells[1].from).toBe(source.indexOf("| C |"));
  });

  it("parses a trailing empty cell with raw === '' AND a zero-width span at the trailing pipe", () => {
    const source = "| A |   |\n| - | - |\n";
    const t = parseTable(source, 0, source.length - 1);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.cells.map((c) => c.raw)).toEqual(["A", ""]);
    expect(t.header.cells[1].from).toBe(t.header.cells[1].to);
    // Trailing empty cell sits at the row's closing `|`.
    expect(t.header.cells[1].from).toBe(source.indexOf("|\n"));
  });
});

describe("parseTable CRLF", () => {
  it("strips \\r\\n terminators and reports lineEnding=\\r\\n per row", () => {
    const source = "| A | B |\r\n| - | - |\r\n| 1 | 2 |\r\n";
    // Slice off the trailing \r\n so Table.to lands at the last `|`.
    const t = parseTable(source, 0, source.length - 2);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.lineEnding).toBe("\r\n");
    expect(t.delimiter.lineEnding).toBe("\r\n");
    expect(t.rows[0].lineEnding).toBe(""); // last row in slice
    expect(t.header.cells.map((c) => c.raw)).toEqual(["A", "B"]);
    expect(t.rows[0].cells.map((c) => c.raw)).toEqual(["1", "2"]);
  });

  it("treats LF and CRLF in the same document per row", () => {
    // Mixed (defensive): header uses LF, body uses CRLF.
    const source = "| A |\n| - |\r\n| x |";
    const t = parseTable(source, 0, source.length);
    expect(t).not.toBeNull();
    if (!t) {
      return;
    }
    expect(t.header.lineEnding).toBe("\n");
    expect(t.delimiter.lineEnding).toBe("\r\n");
    expect(t.rows[0].lineEnding).toBe("");
  });
});

describe("parseAllTables", () => {
  it("finds and parses multiple tables interleaved with paragraphs", () => {
    const src = [
      "Intro paragraph.",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "Middle text.",
      "",
      "| X | Y |",
      "| - | - |",
      "| 3 | 4 |",
      "",
    ].join("\n");
    const tables = parseAllTables(src);
    expect(tables).toHaveLength(2);
    expect(tables[0].rows[0].cells[0].raw).toBe("1");
    expect(tables[1].rows[0].cells[1].raw).toBe("4");
  });

  it("returns [] when no table is present", () => {
    expect(parseAllTables("Just a paragraph.\n")).toEqual([]);
  });
});

describe("findTableRanges offset + 1-col body contract", () => {
  it("1-col CRLF body: findTableRanges computes correct to offset", () => {
    const source = "| A |\r\n| - |\r\nAlice\r\nBob\r\n";
    const tables = parseAllTables(source);
    expect(tables).toHaveLength(1);
    // `to` must stop at the last `b` of "Bob", NOT at the \r
    const slice = source.slice(tables[0].from, tables[0].to);
    expect(slice).toBe("| A |\r\n| - |\r\nAlice\r\nBob");
    expect(tables[0].rows[1].cells[0].raw).toBe("Bob");
  });

  it("multi-col table: to stops at last pipe, bare text after blank is NOT included", () => {
    const source = "| A | B |\n| - | - |\n| 1 | 2 |\n\nBare text\n";
    const tables = parseAllTables(source);
    expect(tables).toHaveLength(1);
    const lastTableLine = "| 1 | 2 |";
    const expectedTo = source.indexOf(lastTableLine) + lastTableLine.length;
    expect(tables[0].to).toBe(expectedTo);
  });

  it("1-col table: to stops at last body row; text after blank is not part of the table", () => {
    const source = "| Name |\n| ---- |\nAlice\nBob\n\nAfter\n";
    const tables = parseAllTables(source);
    expect(tables).toHaveLength(1);
    const expectedTo = source.indexOf("Bob") + "Bob".length;
    expect(tables[0].to).toBe(expectedTo);
  });

  it("1-col table: blank line immediately after header+delimiter produces empty body, does not consume next bare-text line", () => {
    const source = "| Name |\n| ---- |\n\nAlice\n";
    const tables = parseAllTables(source);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows).toHaveLength(0);
    expect(tables[0].to).toBe(source.indexOf("| ---- |") + "| ---- |".length);
  });

  it("1-col delimiter with trailing whitespace still enables pipeless body extension", () => {
    const source = "| Name |\n| - |  \nAlice\n";
    const tables = parseAllTables(source);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows[0].cells[0].raw).toBe("Alice");
    expect(tables[0].to).toBe(source.indexOf("Alice") + "Alice".length);
  });

  it("1-col delimiter with trailing tab still enables pipeless body extension", () => {
    const source = "| Name |\n| - |\t\nAlice\n";
    const tables = parseAllTables(source);
    expect(tables).toHaveLength(1);
    expect(tables[0].rows[0].cells[0].raw).toBe("Alice");
    expect(tables[0].to).toBe(source.indexOf("Alice") + "Alice".length);
  });
});
