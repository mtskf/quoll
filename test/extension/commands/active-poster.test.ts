import { describe, expect, it, vi } from "vitest";
import { createActivePoster } from "../../../src/extension/commands/active-poster.js";

describe("createActivePoster", () => {
  it("set then get returns the poster", () => {
    const reg = createActivePoster<() => void>();
    const p = vi.fn();
    reg.set(p);
    expect(reg.get()).toBe(p);
  });
  it("identity-guarded clear does not wipe a newer poster", () => {
    const reg = createActivePoster<() => void>();
    const a = vi.fn();
    const b = vi.fn();
    reg.set(a);
    reg.set(b);
    reg.clear(a); // stale clear
    expect(reg.get()).toBe(b);
    reg.clear(b);
    expect(reg.get()).toBeNull();
  });
});
