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

  it("never refunds a charge: a spend stays spent for the life of the session", () => {
    // No release/refund counterpart exists — a charged write is permanent even
    // if the write later fails, so total disk growth stays bounded by the cap.
    const budget = createSessionVolumeBudget(10, vi.fn());
    expect(budget.reserve(10)).toBe(true); // spent 10 — full
    expect(budget.reserve(1)).toBe(false); // still full; the charge did not lapse
    expect("release" in budget).toBe(false); // no refund API to reopen the cap
  });

  it("rejects a NaN or negative byteLength instead of poisoning the running total", () => {
    const budget = createSessionVolumeBudget(10, vi.fn());
    expect(() => budget.reserve(Number.NaN)).toThrow(RangeError);
    expect(() => budget.reserve(-1)).toThrow(RangeError);
    expect(() => budget.reserve(1.5)).toThrow(RangeError);
    // The cap is still intact after the rejected inputs (spent untouched).
    expect(budget.reserve(10)).toBe(true);
  });
});
