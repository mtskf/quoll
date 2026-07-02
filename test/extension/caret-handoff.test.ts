import { describe, expect, it } from "vitest";

import { type Caret, clampCaret } from "../../src/extension/caret-handoff.js";

// A 3-line document: line 0 len 5, line 1 len 3, line 2 len 0.
const lineLengths = [5, 3, 0];
const lineLengthAt = (line: number) => lineLengths[line] ?? 0;
const LINE_COUNT = 3;

describe("clampCaret", () => {
  it("passes through an in-bounds caret", () => {
    expect(clampCaret({ line: 1, character: 2 }, LINE_COUNT, lineLengthAt)).toEqual({
      line: 1,
      character: 2,
    });
  });

  it("clamps an over-large line to the last line", () => {
    expect(clampCaret({ line: 99, character: 0 }, LINE_COUNT, lineLengthAt)).toEqual({
      line: 2,
      character: 0,
    });
  });

  it("clamps the character to the clamped line's length", () => {
    // line 0 has length 5 => character 99 clamps to 5.
    expect(clampCaret({ line: 0, character: 99 }, LINE_COUNT, lineLengthAt)).toEqual({
      line: 0,
      character: 5,
    });
  });

  it("clamps an over-large line then bounds character against THAT line", () => {
    // line 99 -> 2 (len 0) => character clamps to 0.
    expect(clampCaret({ line: 99, character: 99 }, LINE_COUNT, lineLengthAt)).toEqual({
      line: 2,
      character: 0,
    });
  });

  it("clamps negatives to 0", () => {
    const c: Caret = { line: -3, character: -3 };
    expect(clampCaret(c, LINE_COUNT, lineLengthAt)).toEqual({ line: 0, character: 0 });
  });

  it("never returns a negative line for an empty document (lineCount 0)", () => {
    expect(clampCaret({ line: 5, character: 5 }, 0, () => 0)).toEqual({ line: 0, character: 0 });
  });
});
