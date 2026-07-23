import { describe, expect, it } from "vitest";
import { applyEdits, type Edit } from "../../../src/markdown/format/edit.js";

describe("applyEdits", () => {
  it("applies non-overlapping edits in one pass regardless of input order", () => {
    const edits: Edit[] = [
      { from: 4, to: 5, insert: "E" },
      { from: 0, to: 1, insert: "A" },
    ];
    expect(applyEdits("abcdef", edits)).toBe("AbcdEf");
  });

  it("is a no-op for an empty edit list", () => {
    expect(applyEdits("hello", [])).toBe("hello");
  });

  it("throws on overlapping edits", () => {
    const edits: Edit[] = [
      { from: 0, to: 3, insert: "X" },
      { from: 2, to: 4, insert: "Y" },
    ];
    expect(() => applyEdits("abcdef", edits)).toThrow(/overlap/i);
  });

  it("throws on an out-of-range edit (to > length)", () => {
    expect(() => applyEdits("abc", [{ from: 0, to: 99, insert: "X" }])).toThrow(/out of range/i);
  });

  it("allows abutting edits (to === next.from)", () => {
    const edits: Edit[] = [
      { from: 0, to: 2, insert: "X" },
      { from: 2, to: 4, insert: "Y" },
    ];
    expect(applyEdits("abcdef", edits)).toBe("XYef");
  });
});
