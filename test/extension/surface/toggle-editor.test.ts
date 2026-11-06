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

// Keep the REAL findSourceTab (active-tab-first) and replace only the forward
// wrapper, so the command's wiring — not the wrapper's own mapping, pinned in
// surface-swap.test.ts — is what these cases observe.
vi.mock("../../../src/extension/surface/surface-swap.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/extension/surface/surface-swap.js")>()),
  finalizeForwardSwap: vi.fn(async () => undefined),
}));

vi.mock("../../../src/extension/surface/reopen-text-editor.js", () => ({
  openInTextEditor: vi.fn(async () => undefined),
}));

import { openInTextEditor } from "../../../src/extension/surface/reopen-text-editor.js";
import {
  __clearSurfaceMemoryForTest,
  __getRememberedSurfaceForTest,
  noteSurface,
} from "../../../src/extension/surface/surface-memory.js";
import { finalizeForwardSwap } from "../../../src/extension/surface/surface-swap.js";
import {
  decideSwitchTarget,
  reopenActiveQuollTabAsText,
} from "../../../src/extension/surface/toggle-editor.js";

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
  const KEY = "file:///a.md";
  const uri = { toString: () => KEY, path: "/a.md", scheme: "file" } as never;
  const activeTabGroup = window.tabGroups.activeTabGroup as { activeTab: unknown };
  const finalizeMock = vi.mocked(finalizeForwardSwap);
  const openMock = vi.mocked(openInTextEditor);
  let sourceTab: { input: TabInputCustom };
  let savedActiveTab: unknown;

  beforeEach(() => {
    vi.clearAllMocks();
    __clearSurfaceMemoryForTest();
    savedActiveTab = activeTabGroup.activeTab;
    sourceTab = { input: new TabInputCustom(uri, "quoll.editMarkdown") };
    activeTabGroup.activeTab = sourceTab;
  });

  afterEach(() => {
    activeTabGroup.activeTab = savedActiveTab;
  });

  it("hands the swap to finalizeForwardSwap once, with the captured source tab", async () => {
    await reopenActiveQuollTabAsText();
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(finalizeMock).toHaveBeenCalledTimes(1);
    const [calledUri, calledTab] = finalizeMock.mock.calls[0] ?? [];
    expect(calledUri).toBe(uri);
    expect(calledTab).toBe(sourceTab);
    // The command itself writes nothing on this path — the wrapper owns it.
    expect(__getRememberedSurfaceForTest(KEY)).toBeUndefined();
  });

  it("writes nothing and skips the wrapper when the open itself fails", async () => {
    noteSurface(KEY, "text");
    openMock.mockImplementationOnce(async () => {
      throw new Error("openWith failed");
    });
    await reopenActiveQuollTabAsText();
    expect(__getRememberedSurfaceForTest(KEY)).toBe("text");
    expect(finalizeMock).not.toHaveBeenCalled();
  });
});
