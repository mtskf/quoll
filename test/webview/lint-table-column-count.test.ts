import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../src/webview/cm/lint/engine.js";

const tableDiags = (doc: string) =>
  lintMarkdown(doc).filter((d) => d.code === "table-column-count");

describe("lint rule: table-column-count", () => {
  it("flags a body row with fewer cells than the delimiter row", () => {
    const doc = "| a | b |\n| - | - |\n| 1 |\n";
    const diags = tableDiags(doc);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("warning");
    // The diagnostic covers the ragged row line.
    expect(doc.slice(d.from, d.to)).toBe("| 1 |");
    expect(d.message).toContain("1 cell");
    expect(d.message).toContain("2 columns");
  });

  it("flags a body row with more cells than the delimiter row", () => {
    const doc = "| a | b |\n| - | - |\n| 1 | 2 | 3 |\n";
    const diags = tableDiags(doc);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("warning");
    expect(doc.slice(d.from, d.to)).toBe("| 1 | 2 | 3 |");
    expect(d.message).toContain("3 cells");
    expect(d.message).toContain("2 columns");
  });

  it("does not flag a well-formed table", () => {
    expect(tableDiags("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n")).toHaveLength(0);
  });

  it("flags each ragged row independently, on the right rows", () => {
    const doc = "| a | b | c |\n| - | - | - |\n| 1 |\n| 2 | 3 | 4 | 5 |\n";
    const diags = tableDiags(doc);
    expect(diags).toHaveLength(2);
    // Assert row identity, not just the count: a rule that flagged the correct
    // number of wrong rows (e.g. header/delimiter) would still hit length 2.
    expect(doc.slice(diags[0]!.from, diags[0]!.to)).toBe("| 1 |");
    expect(doc.slice(diags[1]!.from, diags[1]!.to)).toBe("| 2 | 3 | 4 | 5 |");
  });

  it("does not flag a blockquote-nested table (parseTable cannot model it)", () => {
    // Lezer forms a Table node for the quoted table, but parseTable returns null
    // for the ">"-prefixed slice — the rule skips it rather than mis-attributing.
    expect(tableDiags("> | a | b |\n> | - | - |\n> | 1 |\n")).toHaveLength(0);
  });

  it("counts a pipeless trailing line as a 1-cell row (GFM) and flags it", () => {
    // A non-blank line right after a table with no blank separator is a
    // legitimate 1-cell body row per GFM — ragged against a 2-column table.
    const doc = "| a | b |\n| - | - |\n| 1 | 2 |\ntrailing\n";
    const diags = tableDiags(doc);
    expect(diags).toHaveLength(1);
    expect(doc.slice(diags[0]!.from, diags[0]!.to)).toBe("trailing");
  });

  it("does not flag when a blank line separates a following paragraph", () => {
    expect(tableDiags("| a | b |\n| - | - |\n| 1 | 2 |\n\ntrailing paragraph\n")).toHaveLength(0);
  });
});
