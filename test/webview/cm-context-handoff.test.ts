// @vitest-environment happy-dom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION } from "../../src/shared/protocol.js";
import {
  CODEX_CONTEXT_HANDOFF_KEY,
  CONTEXT_HANDOFF_KEY,
  codexContextHandoffCommand,
  contextHandoffCommand,
  selectionToHandoff,
} from "../../src/webview/cm/context-handoff.js";

const doc = "line1\nline2\nline3\nline4\nline5";

function stateWith(anchor: number, head: number): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.single(anchor, head),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  });
}

describe("selectionToHandoff", () => {
  it("reports no selection for an empty caret and carries the caret line", () => {
    // caret on line 2 (offset 8 is inside "line2")
    expect(selectionToHandoff(stateWith(8, 8))).toEqual({
      hasSelection: false,
      startLine: 2,
      endLine: 2,
    });
  });

  it("reports a single-line selection", () => {
    // within line 1 (offsets 1..4)
    expect(selectionToHandoff(stateWith(1, 4))).toEqual({
      hasSelection: true,
      startLine: 1,
      endLine: 1,
    });
  });

  it("reports a multi-line selection by 1-based start/end lines", () => {
    // from line 2 (offset 6) to line 4 (offset 20, inside "line4")
    expect(selectionToHandoff(stateWith(6, 20))).toEqual({
      hasSelection: true,
      startLine: 2,
      endLine: 4,
    });
  });

  it("normalizes a reversed selection (head before anchor)", () => {
    expect(selectionToHandoff(stateWith(20, 6))).toEqual({
      hasSelection: true,
      startLine: 2,
      endLine: 4,
    });
  });

  it("includes the trailing line when the selection ends at its start (native parity)", () => {
    // Select "line1\nline2\n" → to = 12 (start of line 3). CM `to` is
    // EXCLUSIVE, and lineAt(to).number = 3. This deliberately matches Claude
    // Code's native end.line+1 (which over-counts the same way), so the
    // reference resolves identically to the native at-mention. NOT a bug —
    // pinned so a future "subtract one" refactor that breaks parity reds CI.
    expect(selectionToHandoff(stateWith(0, 12))).toEqual({
      hasSelection: true,
      startLine: 1,
      endLine: 3,
    });
  });

  it("uses the MAIN range only under a multi-range selection", () => {
    // Two ranges; main = the second (lines 4..5). The other range (line 1)
    // must be ignored — contract: handoff hands off the main selection.
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create(
        // Second range spans line 4 (offset 18) into line 5 (offset 26, inside
        // "line5") — head must reach past line 4's boundary (offset 23) for
        // lineAt(to) to resolve to line 5 under the native-parity `lineAt(to)`
        // rule pinned above.
        [EditorSelection.range(0, 3), EditorSelection.range(18, 26)],
        1 // mainIndex → second range
      ),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    expect(selectionToHandoff(state)).toEqual({
      hasSelection: true,
      startLine: 4,
      endLine: 5,
    });
  });
});

describe("contextHandoffCommand", () => {
  it("posts a context-handoff message for the current selection", () => {
    const postMessage = vi.fn();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: stateWith(6, 20), parent });
    try {
      const handled = contextHandoffCommand({ postMessage })(view);
      expect(handled).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        protocol: PROTOCOL_VERSION,
        type: "context-handoff",
        hasSelection: true,
        startLine: 2,
        endLine: 4,
      });
    } finally {
      view.destroy();
    }
  });

  it("returns true even when postMessage throws (chord is claimed)", () => {
    const postMessage = vi.fn(() => {
      throw new Error("transport gone");
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: stateWith(0, 0), parent });
    try {
      expect(contextHandoffCommand({ postMessage })(view)).toBe(true);
    } finally {
      view.destroy();
    }
  });
});

describe("CONTEXT_HANDOFF_KEY", () => {
  it("is the Cmd+Option+K / Ctrl+Alt+K chord", () => {
    // Pin the chord string. The real platform-resolved binding is verified in
    // the Task 6 manual smoke (happy-dom's CM platform detection makes a
    // synthetic-key runScopeHandlers test non-deterministic).
    expect(CONTEXT_HANDOFF_KEY).toBe("Mod-Alt-k");
  });
});

describe("CODEX_CONTEXT_HANDOFF_KEY", () => {
  it("is the Mod-j chord", () => {
    expect(CODEX_CONTEXT_HANDOFF_KEY).toBe("Mod-j");
  });
});

describe("codexContextHandoffCommand", () => {
  it("posts a codex-context-handoff envelope with no selection geometry", () => {
    const postMessage = vi.fn();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    // Selection present — must NOT leak into the Codex message (whole-file).
    const view = new EditorView({ state: stateWith(6, 20), parent });
    try {
      const handled = codexContextHandoffCommand({ postMessage })(view);
      expect(handled).toBe(true);
      expect(postMessage).toHaveBeenCalledWith({
        protocol: PROTOCOL_VERSION,
        type: "codex-context-handoff",
      });
    } finally {
      view.destroy();
    }
  });

  it("returns true even when postMessage throws (chord is claimed)", () => {
    const postMessage = vi.fn(() => {
      throw new Error("transport gone");
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: stateWith(0, 0), parent });
    try {
      expect(codexContextHandoffCommand({ postMessage })(view)).toBe(true);
    } finally {
      view.destroy();
    }
  });
});
