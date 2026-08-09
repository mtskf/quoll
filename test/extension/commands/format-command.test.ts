import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, window } from "vscode"; // vitest-aliased to test/extension/vscode-stub.ts
import {
  __getActivePosterForTest,
  clearActiveFormatPoster,
  normalizeFormatAction,
  registerFormatCommand,
  runFormatCommand,
  setActiveFormatPoster,
} from "../../../src/extension/commands/format-command.js";

/** Hand the module-singleton registry back empty, whatever the test left in it
 *  (the identity guard means only the currently-active poster can clear it). */
function releaseActivePoster(): void {
  const active = __getActivePosterForTest();
  if (active !== null) {
    clearActiveFormatPoster(active);
  }
}

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
  // Every describe owns its own cleanup of the module-singleton registry, so no
  // block's result depends on where it sits in the file (the identity-guard test
  // below deliberately leaves `b` set).
  afterEach(releaseActivePoster);

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
  // The "no active panel" case below is only meaningful on an empty registry,
  // and this block runs after one that sets posters — so assert the hand-off
  // rather than trusting the previous block to have cleaned up after itself.
  beforeEach(() => {
    expect(__getActivePosterForTest()).toBeNull();
  });

  afterEach(() => {
    releaseActivePoster();
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

  it("explains itself when the argument is missing (a hand-written keybindings.json entry)", () => {
    // Pre-fix this fell off the end of the handler: no post, no log, no toast —
    // provably nothing, every time. Not reachable from the Command Palette:
    // package.json hides quoll.format there (see package-contributions.test.ts).
    setActiveFormatPoster(vi.fn());
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand(undefined);

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/needs an action argument/);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/bold/);
  });

  it("names the offending value when the argument is not a known action", () => {
    // Distinct from the missing-argument arm: the fix here is to correct the
    // action, not to add one, so the toast must not send the user hunting.
    setActiveFormatPoster(vi.fn());
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand("underline");

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/"underline" is not a recognized action/);
    expect(String(info.mock.calls[0]?.[0])).not.toMatch(/needs an action argument/);
  });

  it("explains itself when no Quoll panel is active", () => {
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand("italic"); // registry empty — no panel registered

    expect(info).toHaveBeenCalledTimes(1);
    // Match this branch's own wording, not the shared "Quoll:" prefix — a
    // swapped pair of toasts must fail here.
    expect(String(info.mock.calls[0]?.[0])).toMatch(/open a Markdown file/);
  });
});

describe("command registration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wires quoll.format to runFormatCommand", () => {
    // The command id and the handler are the whole contract of the activation
    // path; nothing else in the suite exercises them.
    const spy = vi.spyOn(commands, "registerCommand");

    registerFormatCommand();

    expect(spy).toHaveBeenCalledWith("quoll.format", runFormatCommand);
  });
});
