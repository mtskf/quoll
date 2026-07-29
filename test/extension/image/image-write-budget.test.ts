import { describe, expect, it, vi } from "vitest";

import { createSessionVolumeBudget } from "../../../src/extension/image/image-write-budget.js";

describe("createSessionVolumeBudget", () => {
  it("allows writes up to (and including) the budget, then rejects", () => {
    const onExceeded = vi.fn();
    const budget = createSessionVolumeBudget(100, onExceeded);

    expect(budget.reserve(60)).toBe(true); // spent 60
    expect(budget.reserve(40)).toBe(true); // spent 100 — exactly at the cap
    expect(budget.reserve(1)).toBe(false); // 101 > 100 — over budget
    expect(onExceeded).toHaveBeenCalledOnce();
  });

  it("warns exactly once no matter how many over-budget writes follow", () => {
    const onExceeded = vi.fn();
    const budget = createSessionVolumeBudget(10, onExceeded);

    expect(budget.reserve(8)).toBe(true); // spent 8
    expect(budget.reserve(5)).toBe(false); // 13 > 10 — first over-budget, warns
    expect(budget.reserve(5)).toBe(false); // still over — no second warning
    expect(onExceeded).toHaveBeenCalledOnce();
  });

  it("does not charge the budget for a rejected write (a rejected spend cannot exhaust it)", () => {
    const onExceeded = vi.fn();
    const budget = createSessionVolumeBudget(10, onExceeded);

    expect(budget.reserve(8)).toBe(true); // spent 8
    expect(budget.reserve(5)).toBe(false); // 13 > 10 — rejected, NOT charged
    expect(budget.reserve(2)).toBe(true); // 8 + 2 = 10 still fits
    expect(budget.reserve(1)).toBe(false); // 11 > 10
  });
});
