import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { lineRangeOverlapsSelection } from "../../src/webview/cm/bounded-recompute.js";

describe("lineRangeOverlapsSelection", () => {
  it("detects inclusive-boundary overlap", () => {
    const sel = EditorSelection.single(10, 10); // caret at offset 10
    expect(lineRangeOverlapsSelection(sel, 10, 20)).toBe(true); // caret == from
    expect(lineRangeOverlapsSelection(sel, 0, 10)).toBe(true); // caret == to
  });
  it("returns false for a disjoint range", () => {
    const sel = EditorSelection.single(5, 5);
    expect(lineRangeOverlapsSelection(sel, 20, 30)).toBe(false);
  });
  it("matches when ANY range in a multi-cursor selection overlaps", () => {
    const sel = EditorSelection.create([
      EditorSelection.range(0, 1),
      EditorSelection.range(25, 26),
    ]);
    expect(lineRangeOverlapsSelection(sel, 20, 30)).toBe(true);
  });
});
