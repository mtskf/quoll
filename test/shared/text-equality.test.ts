import { describe, expect, it } from "vitest";
import { sameTextIgnoringEol } from "../../src/shared/text-equality.js";
import { EOL_PAIRS } from "./eol-pair-table.js";

// BEHAVIOUR ONLY. test/shared is in no tsconfig and vitest is transpile-only, so
// a type-level assertion placed here would be permanently vacuous (.claude/CLAUDE.md
// "Before finishing ANY change"). Nothing below is a type assertion.
describe("sameTextIgnoringEol", () => {
  for (const { label, a, b, expected } of EOL_PAIRS) {
    it(`${label}: ${expected ? "equal" : "different"}`, () => {
      expect(sameTextIgnoringEol(a, b)).toBe(expected);
      // Symmetric: both sides of the wire ask the question in whichever order
      // their own state shape gives them, so an asymmetric implementation would
      // make the two sides disagree on the same pair.
      expect(sameTextIgnoringEol(b, a)).toBe(expected);
    });
  }

  it("normalises every EOL in a multi-line document, not just the first", () => {
    // The replace is global; a non-global regex would pass every row above
    // (each has one line break) and still mis-compare real documents.
    expect(sameTextIgnoringEol("a\r\nb\r\nc", "a\nb\nc")).toBe(true);
    expect(sameTextIgnoringEol("a\r\nb\r\nc", "a\nb\nd")).toBe(false);
  });

  it("does not equate a line break with its absence", () => {
    expect(sameTextIgnoringEol("ab", "a\nb")).toBe(false);
  });
});
