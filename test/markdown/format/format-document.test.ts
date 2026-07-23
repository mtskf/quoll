import { describe, expect, it } from "vitest";
import { formatDocument, formatDocumentEdits } from "../../../src/markdown/format/index.js";

describe("formatDocument", () => {
  it("applies table, renumber, blank, and trim rules together", () => {
    const src = "# Title  \n\n\n\n1. x\n1. y\n\n| a | bb |\n| - | - |\n| 1 | 2 |\n";
    const out = formatDocument(src);
    expect(out).toContain("# Title  "); // trailing 2 spaces byte-preserved
    expect(out).toContain("1. x\n2. y");
    expect(out).toContain("| a   | bb  |");
    expect(out).not.toContain("\n\n\n");
  });
  it("leaves fenced code contents byte-untouched", () => {
    const src = "```js\nlet   a=1   \n1.  not renumbered\n```\n";
    expect(formatDocument(src)).toBe(src);
  });
  it("leaves raw HTML block contents byte-untouched", () => {
    const src = "<div>\n  <b>keep   spaces</b>   \n</div>\n";
    expect(formatDocument(src)).toBe(src);
  });
  it("leaves frontmatter byte-untouched", () => {
    const src = "---\ntitle:   x   \nlist:\n  - a\n---\n\nbody\n";
    expect(formatDocument(src)).toContain("title:   x   ");
  });
  it("does not trim inside a table (interior whitespace owned by table rule)", () => {
    // ragged table left byte-untouched incl. its own spacing
    const src = "| a | b |\n| - | - |\n| only |\n";
    expect(formatDocument(src)).toBe(src);
  });
  it("returns empty input unchanged / empty edit list", () => {
    expect(formatDocument("")).toBe("");
    expect(formatDocumentEdits("")).toEqual([]);
  });
});
