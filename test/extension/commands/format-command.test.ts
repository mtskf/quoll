import { afterEach, describe, expect, it, vi } from "vitest";
import { window } from "vscode"; // vitest-aliased to test/extension/vscode-stub.ts
import {
  __getActivePosterForTest,
  clearActiveFormatPoster,
  normalizeFormatAction,
  runFormatCommand,
  setActiveFormatPoster,
} from "../../../src/extension/commands/format-command.js";

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

describe("runFormatCommand — the arms that used to be silent", () => {
  afterEach(() => {
    const active = __getActivePosterForTest();
    if (active !== null) {
      clearActiveFormatPoster(active);
    }
    vi.restoreAllMocks();
  });

  it("forwards a known action to the active panel without a toast", () => {
    const post = vi.fn();
    setActiveFormatPoster(post);
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand("bold");

    expect(post).toHaveBeenCalledWith("bold");
    expect(info).not.toHaveBeenCalled();
  });

  it("explains itself when the argument is missing (a bare palette-style call)", () => {
    // Pre-fix this fell off the end of the handler: no post, no log, no toast —
    // provably nothing, every time.
    setActiveFormatPoster(vi.fn());
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand(undefined);

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/bold/);
  });

  it("explains itself when no Quoll panel is active", () => {
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand("italic"); // registry empty — no panel registered

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/Quoll/);
  });
});
