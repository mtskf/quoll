import { describe, expect, it, vi } from "vitest";
import {
  __getActivePosterForTest,
  clearActiveFormatPoster,
  normalizeFormatAction,
  setActiveFormatPoster,
} from "../../src/extension/format-command.js";

describe("normalizeFormatAction", () => {
  it("accepts the five known actions", () => {
    for (const a of ["bold", "italic", "code", "strike", "link"]) {
      expect(normalizeFormatAction(a)).toBe(a);
    }
  });
  it("rejects junk", () => {
    expect(normalizeFormatAction("underline")).toBeNull();
    expect(normalizeFormatAction(undefined)).toBeNull();
    expect(normalizeFormatAction(42)).toBeNull();
  });
});

describe("active poster tracker", () => {
  it("set then clear (same identity) removes it", () => {
    const p = vi.fn();
    setActiveFormatPoster(p);
    expect(__getActivePosterForTest()).toBe(p);
    clearActiveFormatPoster(p);
    expect(__getActivePosterForTest()).toBeNull();
  });
  it("clear with a stale poster is a no-op (identity guard)", () => {
    const a = vi.fn();
    const b = vi.fn();
    setActiveFormatPoster(a);
    setActiveFormatPoster(b); // b is now active (panel switch)
    clearActiveFormatPoster(a); // a's late clear must NOT wipe b
    expect(__getActivePosterForTest()).toBe(b);
  });
});
