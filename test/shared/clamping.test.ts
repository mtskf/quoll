import { describe, expect, it } from "vitest";
import { clampInt } from "../../src/shared/clamping.js";

describe("clampInt", () => {
  it("returns min when value is non-finite", () => {
    expect(clampInt(Number.NaN, 3, 9)).toBe(3);
    expect(clampInt(Number.POSITIVE_INFINITY, 3, 9)).toBe(3);
  });
  it("truncates toward zero then clamps into [min, max]", () => {
    expect(clampInt(5.9, 0, 10)).toBe(5);
    expect(clampInt(-2, 0, 10)).toBe(0);
    expect(clampInt(999, 0, 10)).toBe(10);
    expect(clampInt(7, 0, 10)).toBe(7);
  });
});
