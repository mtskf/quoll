import { describe, expect, it } from "vitest";

import { createRevealCaretSuppression } from "../../../src/extension/handoff/reveal-caret-suppression.js";

describe("createRevealCaretSuppression", () => {
  it("consume() is false before any arm()", () => {
    const s = createRevealCaretSuppression();
    expect(s.consume()).toBe(false);
  });

  it("arm() then consume() returns true exactly once (read-and-clear)", () => {
    const s = createRevealCaretSuppression();
    s.arm();
    expect(s.consume()).toBe(true);
    expect(s.consume()).toBe(false);
  });

  it("arm() is idempotent — a second arm before consume stays a single latch", () => {
    const s = createRevealCaretSuppression();
    s.arm();
    s.arm();
    expect(s.consume()).toBe(true);
    expect(s.consume()).toBe(false);
  });

  it("re-arms after a consume", () => {
    const s = createRevealCaretSuppression();
    s.arm();
    expect(s.consume()).toBe(true);
    s.arm();
    expect(s.consume()).toBe(true);
    expect(s.consume()).toBe(false);
  });
});
