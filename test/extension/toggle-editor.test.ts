import { describe, expect, it, vi } from "vitest";

// toggle-editor.ts value-imports QuollEditorPanel (for `.viewType`); mock it so
// loading this test does NOT evaluate the full panel module (and its many vscode
// surfaces) under the stub — same pattern as extension.activate.test.ts. The
// pure decideSwitchTarget under test does not touch QuollEditorPanel.
vi.mock("../../src/extension/quoll-editor-panel.js", () => ({
  QuollEditorPanel: { viewType: "quoll.editMarkdown" },
}));

import { decideSwitchTarget } from "../../src/extension/toggle-editor.js";

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
