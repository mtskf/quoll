import { describe, expect, it } from "vitest";
import { applyEdits } from "../../../src/markdown/format/edit.js";
import { classifyDocument } from "../../../src/markdown/format/segment.js";
import { tableEdits } from "../../../src/markdown/format/table-format.js";

// Realistic path: tables come from the Lezer classifier's tableRanges.
const fmt = (s: string) => applyEdits(s, tableEdits(s, classifyDocument(s).tableRanges));

describe("tableEdits", () => {
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

  it("is idempotent", () => {
    const once = fmt("| a | bbbb |\n| - | - |\n| 1 | 2 |\n");
    expect(fmt(once)).toBe(once);
  });
});
