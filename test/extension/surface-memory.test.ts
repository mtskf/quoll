import { beforeEach, describe, expect, it } from "vitest";
import {
  __clearSurfaceMemoryForTest,
  decideOpenReconcile,
  getRememberedSurface,
  noteSurface,
  reconcileOpen,
} from "../../src/extension/surface-memory.js";

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

  it("adopts a text open beside a Quoll sibling (deliberate side-by-side / mid-swap)", () => {
    // memory=quoll but a Quoll tab is already open and text opens beside it →
    // deliberate; adopt text rather than upgrading back to Quoll.
    expect(decideOpenReconcile("quoll", "text", true)).toEqual({ record: "text", reopen: null });
  });
});

describe("reconcileOpen (stateful, in-memory map)", () => {
  it("records the shown surface on a first open and returns null (no reopen)", () => {
    expect(reconcileOpen("file:///a.md", "text", false)).toBeNull();
    expect(getRememberedSurface("file:///a.md")).toBe("text");
  });

  it("returns 'quoll' WITHOUT overwriting memory on a fresh text open when Quoll is remembered", () => {
    noteSurface("file:///a.md", "quoll");
    expect(reconcileOpen("file:///a.md", "text", false)).toBe("quoll");
    // memory is preserved so the incoming Quoll (restore) open matches it
    expect(getRememberedSurface("file:///a.md")).toBe("quoll");
    // the subsequent quoll open reconciles to a match and records
    expect(reconcileOpen("file:///a.md", "quoll", false)).toBeNull();
    expect(getRememberedSurface("file:///a.md")).toBe("quoll");
  });

  it("keys are independent", () => {
    noteSurface("file:///a.md", "quoll");
    noteSurface("file:///b.md", "text");
    expect(getRememberedSurface("file:///a.md")).toBe("quoll");
    expect(getRememberedSurface("file:///b.md")).toBe("text");
  });

  it("is in-memory only: clearing forgets everything (host-restart analogue)", () => {
    noteSurface("file:///a.md", "quoll");
    __clearSurfaceMemoryForTest();
    expect(getRememberedSurface("file:///a.md")).toBeUndefined();
  });
});
