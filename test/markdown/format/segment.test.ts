import { describe, expect, it } from "vitest";
import { classifyDocument, rangesIntersect } from "../../../src/markdown/format/segment.js";

const slice = (s: string, r: { from: number; to: number }) => s.slice(r.from, r.to);

describe("classifyDocument", () => {
  it("protects a fenced code block", () => {
    const src = "text\n\n```js\nlet a=1  \n```\n\nmore\n";
    expect(
      classifyDocument(src).protectedRanges.some((r) => slice(src, r).includes("let a=1"))
    ).toBe(true);
  });

  it("protects TWO adjacent fenced blocks (no skip-walk leak)", () => {
    const src = "```\na\n```\n```\nb\n```\n";
    const prot = classifyDocument(src).protectedRanges;
    expect(prot.some((r) => slice(src, r).includes("a"))).toBe(true);
    expect(prot.some((r) => slice(src, r).includes("b"))).toBe(true);
  });

  it("protects frontmatter at document start (no validateFrontmatter misuse)", () => {
    const src = "---\ntitle:  x  \n---\n\nbody\n";
    expect(
      classifyDocument(src).protectedRanges.some((r) => slice(src, r).startsWith("---\ntitle:"))
    ).toBe(true);
  });

  it("does not treat a mid-document --- as frontmatter", () => {
    const src = "para\n\n---\n\nmore\n";
    expect(classifyDocument(src).protectedRanges).toEqual([]);
  });

  it("protects a raw HTML block", () => {
    const src = "before\n\n<div>\n  keep   \n</div>\n\nafter\n";
    expect(classifyDocument(src).protectedRanges.some((r) => slice(src, r).includes("<div>"))).toBe(
      true
    );
  });

  it("groups ordered list marks", () => {
    const src = "1. a\n2. b\n";
    const lists = classifyDocument(src).orderedLists;
    expect(lists.length).toBe(1);
    expect(lists[0].marks.map((m) => m.text)).toEqual(["1.", "2."]);
  });

  it("treats a nested ordered list as its own group", () => {
    const src = "1. a\n   1. x\n   2. y\n2. b\n";
    const lists = classifyDocument(src).orderedLists;
    expect(lists.length).toBe(2);
    expect(lists.some((l) => l.marks.map((m) => m.text).join() === "1.,2.")).toBe(true);
    expect(lists.some((l) => l.marks.map((m) => m.text).join() === "1.,2.")).toBe(true);
  });

  it("reports a Table node range (parser authority), not absorbing a following heading", () => {
    const src = "| A | B |\n| - | - |\n| 1 | 2 |\n# heading\n";
    const c = classifyDocument(src);
    expect(c.tableRanges.length).toBe(1);
    expect(slice(src, c.tableRanges[0])).toContain("| A | B |");
    expect(slice(src, c.tableRanges[0])).not.toContain("# heading"); // heading is a separate block
  });

  it("excludes a pipe-table inside frontmatter from tableRanges", () => {
    const src = "---\n| a | b |\n| - | - |\n---\n\nbody\n";
    expect(classifyDocument(src).tableRanges).toEqual([]);
  });

  it("rangesIntersect uses intersection not containment", () => {
    const ranges = [{ from: 5, to: 10 }];
    expect(rangesIntersect(ranges, 8, 12)).toBe(true); // partial overlap
    expect(rangesIntersect(ranges, 0, 5)).toBe(false); // abutting, no overlap
  });
});
