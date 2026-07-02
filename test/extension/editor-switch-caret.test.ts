import { describe, expect, it } from "vitest";

import { stashSwitchCaret, takeSwitchCaret } from "../../src/extension/editor-switch-caret.js";

describe("editor-switch caret store", () => {
  it("returns null for an unknown key", () => {
    expect(takeSwitchCaret("file:///nope.md")).toBeNull();
  });

  it("round-trips a stashed caret then clears it (one-shot)", () => {
    const key = "file:///a.md";
    stashSwitchCaret(key, { line: 3, character: 7 });
    expect(takeSwitchCaret(key)).toEqual({ line: 3, character: 7 });
    // A second take is empty — the handoff is consumed, so a later reload does
    // not re-apply a stale switch caret.
    expect(takeSwitchCaret(key)).toBeNull();
  });

  it("keys are independent", () => {
    stashSwitchCaret("file:///a.md", { line: 1, character: 1 });
    stashSwitchCaret("file:///b.md", { line: 2, character: 2 });
    expect(takeSwitchCaret("file:///b.md")).toEqual({ line: 2, character: 2 });
    expect(takeSwitchCaret("file:///a.md")).toEqual({ line: 1, character: 1 });
  });
});
