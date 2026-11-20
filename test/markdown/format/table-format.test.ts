import { describe, expect, it, vi } from "vitest";
import { applyEdits } from "../../../src/markdown/format/edit.js";
import { classifyDocument } from "../../../src/markdown/format/segment.js";
import { FormatTooLargeError, tableEdits } from "../../../src/markdown/format/table-format.js";
import { parseTable } from "../../../src/markdown/table/index.js";

// Realistic path: tables come from the Lezer classifier's tableRanges.
const fmt = (s: string) => applyEdits(s, tableEdits(s, classifyDocument(s).tableRanges));

describe("tableEdits", () => {
  it.each([
    ["alignments", "|h|h|h|h|\n|-|:-|:-:|-:|\n|a|longer|c|d|"],
    ["indents and mixed endings", "  |a|b|\r\n |:-|--:|\n   |longer|b|"],
    ["no body rows", "|a|b|\r\n|-|-|"],
  ])("matches rendered growth for %s", (_name, src) => {
    const ranges = [{ from: 0, to: src.length }];
    const edits = tableEdits(src, ranges);
    const growth = applyEdits(src, edits).length - src.length;
    expect(edits).toHaveLength(1);
    expect(tableEdits(src, ranges, growth)).toEqual(edits);
    expect(() => tableEdits(src, ranges, growth - 1)).toThrow(FormatTooLargeError);
  });

  it("accumulates growth across tables", () => {
    const src = "|a|b|\n|-|-|\n|c|d|\n\n|e|f|\n|-|-|\n|g|h|";
    const ranges = classifyDocument(src).tableRanges;
    const edits = tableEdits(src, ranges);
    const growth = applyEdits(src, edits).length - src.length;
    expect(edits).toHaveLength(2);
    expect(tableEdits(src, ranges, growth)).toEqual(edits);
    for (const range of ranges) {
      expect(tableEdits(src, [range], growth - 1)).toHaveLength(1);
    }
    expect(() => tableEdits(src, ranges, growth - 1)).toThrow(FormatTooLargeError);
  });

  it("credits a shrinking table against later growth", () => {
    const src = "|        a        |        b        |\n|------|------|\n\n|c|d|\n|-|-|";
    const ranges = classifyDocument(src).tableRanges;
    const edits = tableEdits(src, ranges);
    const growth = applyEdits(src, edits).length - src.length;
    expect(edits).toHaveLength(2);
    expect(() => tableEdits(src, ranges.slice(1), growth)).toThrow(FormatTooLargeError);
    expect(tableEdits(src, ranges, growth)).toEqual(edits);
  });

  it("rejects a wide table before generating its padding", () => {
    const src = `|a|b|\n|-|-|\n${"|c|d|\n".repeat(700)}|${"x".repeat(6000)}|e|`;
    const ranges = classifyDocument(src).tableRanges;
    const repeat = vi.spyOn(String.prototype, "repeat");
    try {
      expect(() => tableEdits(src, ranges, 10)).toThrow(FormatTooLargeError);
      expect(repeat).not.toHaveBeenCalledWith(5999);
    } finally {
      repeat.mockRestore();
    }
  });

  it("pads columns to equal width", () => {
    expect(fmt("| a | bbbb |\n| - | - |\n| 1 | 2 |\n")).toBe(
      "| a   | bbbb |\n| --- | ---- |\n| 1   | 2    |\n"
    );
  });

  it("honours alignment colons", () => {
    expect(fmt("| h | h | h |\n|:--|:-:|--:|\n| a | b | c |\n")).toBe(
      "| h   |  h  |   h |\n| :-- | :-: | --: |\n| a   |  b  |   c |\n"
    );
  });

  it("preserves escaped pipes AND per-row cell counts (invariant, not substring)", () => {
    const src = "| a | b |\n| - | - |\n| x \\| y | z |\n";
    // z pads to MIN_WIDTH=3 (same contract as the delimiter row); the invariant
    // under test is that `\|` stays escaped and the row keeps exactly 2 cells.
    expect(fmt(src).split("\n")[2]).toBe("| x \\| y | z   |");
  });

  it("skips a ragged table (row cell-count != columns) byte-untouched", () => {
    const src = "| a | b |\n| - | - |\n| only-one |\n";
    expect(tableEdits(src, classifyDocument(src).tableRanges)).toEqual([]);
  });

  it("does not report a table inside fenced code (classifier excludes it)", () => {
    const src = "```\n| a | b |\n| - | - |\n| 1 | 2 |\n```\n";
    expect(classifyDocument(src).tableRanges).toEqual([]);
    expect(fmt(src)).toBe(src);
  });

  it("skips 1-column tables — avoids the overshoot phantom-row corruption", () => {
    // classifyDocument's tableRange REALLY overshoots (verified against
    // @lezer/markdown): a 1-column table absorbs the trailing line as a phantom
    // body row. Skipping cols===1 leaves the paragraph byte-untouched.
    const plain = "| a |\n| - |\n| 1 |\nplain\n";
    expect(tableEdits(plain, classifyDocument(plain).tableRanges)).toEqual([]);
    expect(fmt(plain)).toBe(plain);
    // Escaped-pipe edge: `plain \| text` is ONE escaped cell (not ragged) whose
    // source contains a literal `|`; a naive includes("|") guard would be fooled
    // and corrupt it. cols===1 skip covers it.
    const esc = "| a |\n| - |\n| 1 |\nplain \\| text\n";
    expect(tableEdits(esc, classifyDocument(esc).tableRanges)).toEqual([]);
    expect(fmt(esc)).toBe(esc);
  });

  it("skips a pipe-less-outer table (leaves the rare form byte-untouched)", () => {
    const src = "a | b\n:-- | --:\n1 | 2\n";
    expect(tableEdits(src, classifyDocument(src).tableRanges)).toEqual([]);
  });

  it("skips a mixed table where a BODY row lacks outer pipes (header-only guard is insufficient)", () => {
    // Piped header, pipe-less body row `x | y`: forcing outer pipes onto the body
    // row changes the Lezer structure signature, so the whole table is skipped.
    const src = "| a | b |\n| - | - |\nx | y\n";
    expect(tableEdits(src, classifyDocument(src).tableRanges)).toEqual([]);
  });

  it("skips a mixed table where the DELIMITER row lacks outer pipes (guard must cover it too)", () => {
    // Piped header and body, but the delimiter `:-- | --:` lacks outer pipes.
    // Forcing outer pipes onto it changes the Lezer structure signature just as a
    // pipe-less header/body row would, so the whole table stays byte-untouched.
    const src = "| a | b |\n:-- | --:\n| 1 | 2 |\n";
    expect(tableEdits(src, classifyDocument(src).tableRanges)).toEqual([]);
    expect(fmt(src)).toBe(src);
  });

  // The parser already strips the ASCII space/tab padding, so whatever is left
  // at a cell's edge is content. One column per alignment (none/left/center/right).
  it.each([
    ["NBSP", "\u00a0"],
    ["ideographic space", "\u3000"],
    ["escaped tab", "\\\t"],
  ])("keeps %s at both cell edges, in header and body, for every alignment", (_name, edge) => {
    const row = (text: string) => `|${Array(4).fill(` ${edge}${text}${edge} `).join("|")}|\n`;
    const src = `${row("h")}|-|:-|:-:|-:|\n${row("body")}`;
    const cells = (s: string) => {
      const table = parseTable(s, 0, s.length);
      return table && [table.header, ...table.rows].map((r) => r.cells.map((c) => c.raw));
    };
    const out = fmt(src);
    expect(out).not.toBe(src);
    expect(cells(out)).toEqual([
      Array(4).fill(`${edge}h${edge}`),
      Array(4).fill(`${edge}body${edge}`),
    ]);
    expect(fmt(out)).toBe(out);
  });

  it("is idempotent", () => {
    const once = fmt("| a | bbbb |\n| - | - |\n| 1 | 2 |\n");
    expect(fmt(once)).toBe(once);
  });
});
