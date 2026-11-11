import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabInputCustom, window } from "vscode";

// toggle-editor.ts value-imports QuollEditorPanel (for `.viewType`); mock it so
// loading this test does NOT evaluate the full panel module (and its many vscode
// surfaces) under the stub — same pattern as extension.activate.test.ts. The
// mock also supplies the `viewType` the forward-command cases below match on
// (the `toggle-editor.ts` active-tab gate + the real `findSourceTab`): a
// mismatch would turn every such case into the early-return no-op.
vi.mock("../../../src/extension/session/quoll-editor-panel.js", () => ({
  QuollEditorPanel: { viewType: "quoll.editMarkdown" },
}));

import { commands } from "vscode";
import { openInTextEditor } from "../../../src/extension/surface/reopen-text-editor.js";
import {
  clearActiveSwitchPoster,
  setActiveSwitchPoster,
} from "../../../src/extension/surface/switch-poster.js";
import {
  decideSwitchTarget,
  reopenActiveQuollTabAsText,
} from "../../../src/extension/surface/toggle-editor.js";

vi.mock("../../../src/extension/surface/reopen-text-editor.js", () => ({
  openInTextEditor: vi.fn(async () => undefined),
}));

describe("decideSwitchTarget", () => {
  it("switches to the text editor when the active tab is Quoll (forward wins)", () => {
    expect(decideSwitchTarget({ onQuollTab: true, activeMarkdownUriKey: "file:///a.md" })).toBe(
      "to-text"
    );
  });

  it("switches to Quoll when a markdown text editor is active", () => {
    expect(decideSwitchTarget({ onQuollTab: false, activeMarkdownUriKey: "file:///a.md" })).toBe(
      "to-quoll"
    );
  });

  it("does nothing when neither a Quoll tab nor a markdown text editor is active", () => {
    expect(decideSwitchTarget({ onQuollTab: false, activeMarkdownUriKey: null })).toBe("none");
  });
});

describe("reopenActiveQuollTabAsText (forward command wiring)", () => {
  const key = "file:///a.md";
  const uri = { toString: () => key, path: "/a.md", scheme: "file" } as never;
  const activeTabGroup = window.tabGroups.activeTabGroup as { activeTab: unknown };
  let savedActiveTab: unknown;
  const poster = vi.fn((_uriKey: string) => true);

  beforeEach(() => {
    vi.clearAllMocks();
    savedActiveTab = activeTabGroup.activeTab;
    activeTabGroup.activeTab = { input: new TabInputCustom(uri, "quoll.editMarkdown") };
  });

  afterEach(() => {
    clearActiveSwitchPoster(poster);
    activeTabGroup.activeTab = savedActiveTab;
    vi.restoreAllMocks();
  });

  it("forwards to the active panel without opening text", async () => {
    setActiveSwitchPoster(poster);
    const execute = vi.spyOn(commands, "executeCommand");
    await reopenActiveQuollTabAsText();
    expect(openInTextEditor).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(poster).toHaveBeenCalledExactlyOnceWith(key);
  });

  it.each(["no panel", "different panel"])("logs and opens nothing with %s", async (scenario) => {
    if (scenario === "different panel") {
      poster.mockReturnValueOnce(false);
      setActiveSwitchPoster(poster);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const execute = vi.spyOn(commands, "executeCommand");
    await reopenActiveQuollTabAsText();
    expect(openInTextEditor).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "[quoll] forward: no Quoll panel for the active tab; switch not sent"
    );
    if (scenario === "different panel") {
      expect(poster).toHaveBeenCalledExactlyOnceWith(key);
    }
  });
});
