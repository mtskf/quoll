import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearSurfaceMemoryForTest,
  __getRememberedSurfaceForTest,
  claimSurface,
  decideOpenReconcile,
  noteSurface,
  noteTextLeftOpen,
  reconcileOpen,
} from "../../../src/extension/surface/surface-memory.js";

beforeEach(() => __clearSurfaceMemoryForTest());

describe("decideOpenReconcile (pure, asymmetric upgrade-to-Quoll)", () => {
  it("adopts the shown surface when there is no memory", () => {
    expect(decideOpenReconcile(undefined, "text", false)).toEqual({ record: "text", reopen: null });
    expect(decideOpenReconcile(undefined, "quoll", false)).toEqual({
      record: "quoll",
      reopen: null,
    });
  });

  it("adopts (records) when the shown surface already matches memory", () => {
    expect(decideOpenReconcile("text", "text", false)).toEqual({ record: "text", reopen: null });
    expect(decideOpenReconcile("quoll", "quoll", false)).toEqual({ record: "quoll", reopen: null });
  });

  it("restores to Quoll on a fresh TEXT open when Quoll is remembered (no sibling)", () => {
    expect(decideOpenReconcile("quoll", "text", false)).toEqual({ record: null, reopen: "quoll" });
  });

  it("NEVER bounces a Quoll open — a Quoll tab is always intentional (priority option)", () => {
    // memory=text, a Quoll tab opens (native Open With / our swap) → adopt Quoll,
    // do NOT bounce back to text. This is the key trap the asymmetry avoids.
    expect(decideOpenReconcile("text", "quoll", false)).toEqual({ record: "quoll", reopen: null });
    expect(decideOpenReconcile("text", "quoll", true)).toEqual({ record: "quoll", reopen: null });
  });

  it("leaves a text open beside a Quoll sibling in place and preserves memory", () => {
    expect(decideOpenReconcile("quoll", "text", true)).toEqual({ record: null, reopen: null });
    expect(decideOpenReconcile(undefined, "text", true)).toEqual({ record: null, reopen: null });
  });
});

describe("reconcileOpen (stateful, in-memory map)", () => {
  it("records the shown surface on a first open and returns null (no reopen)", () => {
    expect(reconcileOpen("file:///a.md", "text", false)).toBeNull();
    expect(__getRememberedSurfaceForTest("file:///a.md")).toBe("text");
  });

  it("returns 'quoll' WITHOUT overwriting memory on a fresh text open when Quoll is remembered", () => {
    noteSurface("file:///a.md", "quoll");
    expect(reconcileOpen("file:///a.md", "text", false)).toBe("quoll");
    // memory is preserved so the incoming Quoll (restore) open matches it
    expect(__getRememberedSurfaceForTest("file:///a.md")).toBe("quoll");
    // the subsequent quoll open reconciles to a match and records
    expect(reconcileOpen("file:///a.md", "quoll", false)).toBeNull();
    expect(__getRememberedSurfaceForTest("file:///a.md")).toBe("quoll");
  });

  it("keys are independent", () => {
    noteSurface("file:///a.md", "quoll");
    noteSurface("file:///b.md", "text");
    expect(__getRememberedSurfaceForTest("file:///a.md")).toBe("quoll");
    expect(__getRememberedSurfaceForTest("file:///b.md")).toBe("text");
  });

  it("is in-memory only: clearing forgets everything (host-restart analogue)", () => {
    noteSurface("file:///a.md", "quoll");
    const claim = claimSurface("file:///a.md");
    __clearSurfaceMemoryForTest();
    expect(claim.isCurrent()).toBe(false);
    expect(__getRememberedSurfaceForTest("file:///a.md")).toBeUndefined();
  });

  it("preserves memory on a text open beside a Quoll sibling", () => {
    noteSurface("file:///a.md", "quoll");
    expect(reconcileOpen("file:///a.md", "text", true)).toBeNull();
    expect(__getRememberedSurfaceForTest("file:///a.md")).toBe("quoll");
  });

  it("preserves a newer native Quoll open when the stale forward text open arrives", () => {
    const key = "file:///a.md";
    const forward = claimSurface(key);
    expect(reconcileOpen(key, "quoll", false)).toBeNull();
    expect(reconcileOpen(key, "text", true)).toBeNull();
    expect(__getRememberedSurfaceForTest(key)).toBe("quoll");
    expect(forward.isCurrent()).toBe(false);
    forward.record("quoll");
    forward.record("text");
    expect(__getRememberedSurfaceForTest(key)).toBe("quoll");
  });
});

describe("claimSurface", () => {
  const key = "file:///a.md";

  it("records while current", () => {
    const claim = claimSurface(key);
    expect(claim.isCurrent()).toBe(true);
    claim.record("text");
    expect(__getRememberedSurfaceForTest(key)).toBe("text");
  });

  it.each([
    ["noteSurface", () => noteSurface(key, "quoll")],
    ["claimSurface", () => claimSurface(key)],
    ["a Quoll open", () => reconcileOpen(key, "quoll", false)],
  ] as const)("is superseded by %s for the same URI", (_label, select) => {
    noteSurface(key, "quoll");
    const claim = claimSurface(key);
    select();
    expect(claim.isCurrent()).toBe(false);
    claim.record("text");
    expect(__getRememberedSurfaceForTest(key)).toBe("quoll");
  });

  it("stays current when a text tab opens beside a Quoll sibling", () => {
    noteSurface(key, "quoll");
    const claim = claimSurface(key);
    expect(reconcileOpen(key, "text", true)).toBeNull();
    expect(claim.isCurrent()).toBe(true);
    expect(__getRememberedSurfaceForTest(key)).toBe("quoll");
  });

  it("stays current when a fresh text open records text", () => {
    const claim = claimSurface(key);
    expect(reconcileOpen(key, "text", false)).toBeNull();
    expect(claim.isCurrent()).toBe(true);
    expect(__getRememberedSurfaceForTest(key)).toBe("text");
  });

  it('stays current when the last Quoll tab closes with text left open (records "text")', () => {
    noteSurface(key, "quoll");
    const claim = claimSurface(key);
    noteTextLeftOpen(key);
    expect(claim.isCurrent()).toBe(true);
    expect(__getRememberedSurfaceForTest(key)).toBe("text");
  });

  it("keeps claims independent across URIs", () => {
    const otherKey = "file:///b.md";
    const claim = claimSurface(key);
    const other = claimSurface(otherKey);
    noteSurface(otherKey, "quoll");
    expect(other.isCurrent()).toBe(false);
    expect(claim.isCurrent()).toBe(true);
    claim.record("text");
    expect(__getRememberedSurfaceForTest(key)).toBe("text");
    expect(__getRememberedSurfaceForTest(otherKey)).toBe("quoll");
  });
});
