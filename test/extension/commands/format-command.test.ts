import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, window } from "vscode"; // vitest-aliased to test/extension/vscode-stub.ts
import {
  clearActivePanelPost,
  getActivePanelPost,
  setActivePanelPost,
} from "../../../src/extension/commands/active-panel.js";
import {
  normalizeFormatAction,
  registerFormatCommand,
  runFormatCommand,
} from "../../../src/extension/commands/format-command.js";
import { FORMAT_ACTIONS, PROTOCOL_VERSION } from "../../../src/shared/protocol.js";

/** Hand the module-singleton registry back empty, whatever the test left in it
 *  (the identity guard means only the currently-active poster can clear it). */
function releaseActivePoster(): void {
  const active = getActivePanelPost();
  if (active !== null) {
    clearActivePanelPost(active);
  }
}

describe("normalizeFormatAction", () => {
  // Iterating the protocol's own list (rather than a copy) is what makes this
  // non-vacuous for a SIXTH action: the case appears here the moment the action
  // set grows, so a guard that silently rejects it fails this test.
  it("accepts every protocol format action", () => {
    expect(FORMAT_ACTIONS.length).toBeGreaterThan(0);
    for (const a of FORMAT_ACTIONS) {
      expect(normalizeFormatAction(a)).toBe(a);
    }
  });
  it("rejects junk", () => {
    expect(normalizeFormatAction("underline")).toBeNull();
    expect(normalizeFormatAction(undefined)).toBeNull();
    expect(normalizeFormatAction(42)).toBeNull();
  });
});

describe("runFormatCommand — the arms that used to be silent", () => {
  // The "no active panel" case below is only meaningful on an empty registry,
  // so assert the hand-off rather than relying on test order.
  beforeEach(() => {
    expect(getActivePanelPost()).toBeNull();
  });

  afterEach(() => {
    releaseActivePoster();
    vi.restoreAllMocks();
  });

  it("forwards a known action to the active panel without a toast", () => {
    const post = vi.fn();
    setActivePanelPost(post);
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand("bold");

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({
      protocol: PROTOCOL_VERSION,
      type: "format-command",
      action: "bold",
    });
    expect(info).not.toHaveBeenCalled();
  });

  it("explains itself when the argument is missing (a hand-written keybindings.json entry)", () => {
    // Pre-fix this fell off the end of the handler: no post, no log, no toast —
    // provably nothing, every time. Not reachable from the Command Palette:
    // package.json hides quoll.format there (see package-contributions.test.ts).
    setActivePanelPost(vi.fn());
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand(undefined);

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/needs a string action argument/);
    expect(String(info.mock.calls[0]?.[0])).toMatch(/bold/);
  });

  it.each([
    ["null", null],
    ["a nested object", { action: "bold" }],
    ["a number", 42],
  ])("treats %s in `args` as a missing action, never as a misspelt one", (_label, arg) => {
    // A hand-edited keybindings.json can put anything in `args`. Routing these
    // through the misspelt-action wording used to print the value with String(),
    // so an object arrived as the useless "[object Object]".
    setActivePanelPost(vi.fn());
    const info = vi.spyOn(window, "showInformationMessage");

    runFormatCommand(arg);

    expect(info).toHaveBeenCalledTimes(1);
    const message = String(info.mock.calls[0]?.[0]);
    expect(message).toMatch(/needs a string action argument/);
    expect(message).not.toMatch(/is not a recognized action/);
    expect(message).not.toMatch(/object Object/);
  });

  it("names the offending value when the argument is not a known action", () => {
    // Distinct from the missing-argument arm: the fix here is to correct the
    // action, not to add one, so the toast must not send the user hunting.
    setActivePanelPost(vi.fn());
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
