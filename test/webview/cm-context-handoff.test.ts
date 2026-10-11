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

// The commands post from a promise continuation; one macrotask drains it.
const flushMicrotasks = () => new Promise<void>((r) => setTimeout(r, 0));
const settled = async () => true;

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

  it("does not over-report when a selection ends exactly at a line start", () => {
    // Select "line1\nline2\n" → to = 12 (start of line 3). CM `to` is EXCLUSIVE,
    // so line 3 has no selected character. Anchoring the end to `to - 1` reports
    // line 2 (the last line actually touched), not the empty line after it.
    expect(selectionToHandoff(stateWith(0, 12))).toEqual({
      hasSelection: true,
      startLine: 1,
      endLine: 2,
    });
  });

  it("keeps the end line when a selection ends mid-line (no under-report)", () => {
    // Select "line1\nli" → to = 8 (inside line 2). The end offset stays on
    // line 2, so `to - 1` must not pull the range back to line 1.
    expect(selectionToHandoff(stateWith(0, 8))).toEqual({
      hasSelection: true,
      startLine: 1,
      endLine: 2,
    });
  });

  it("uses the MAIN range only under a multi-range selection", () => {
    // Two ranges; main = the second (lines 4..5). The other range (line 1)
    // must be ignored — contract: handoff hands off the main selection.
    const state = EditorState.create({
      doc,
      selection: EditorSelection.create(
        // Second range spans line 4 (offset 18) into line 5 (offset 26, inside
        // "line5"); the end offset (to - 1 = 25) stays inside line 5, so the
        // main range resolves to lines 4..5.
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
  it("posts a context-handoff message for the current selection", async () => {
    const postMessage = vi.fn();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: stateWith(6, 20), parent });
    try {
      const handled = contextHandoffCommand({ postMessage }, settled)(view);
      expect(handled).toBe(true);
      await flushMicrotasks();
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

  it("posts only after settle resolves true", async () => {
    let release!: (ok: boolean) => void;
    const settle = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          release = r;
        })
    );
    const postMessage = vi.fn();
    const view = new EditorView({ state: stateWith(6, 20), parent: document.body });
    try {
      expect(contextHandoffCommand({ postMessage }, settle)(view)).toBe(true);
      expect(settle).toHaveBeenCalledTimes(1); // synchronously, inside the key dispatch
      await flushMicrotasks();
      expect(postMessage).not.toHaveBeenCalled();
      release(true);
      await flushMicrotasks();
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "context-handoff" })
      );
    } finally {
      view.destroy();
    }
  });

  it("does not post when settle resolves false (unsynced / cancelled)", async () => {
    const postMessage = vi.fn();
    const view = new EditorView({ state: stateWith(6, 20), parent: document.body });
    try {
      expect(contextHandoffCommand({ postMessage }, async () => false)(view)).toBe(true);
      await flushMicrotasks();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("does not post, and does not throw, when settle throws or rejects", async () => {
    const postMessage = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = new EditorView({ state: stateWith(6, 20), parent: document.body });
    try {
      const throws = () => {
        throw new Error("boom");
      };
      expect(contextHandoffCommand({ postMessage }, throws)(view)).toBe(true);
      expect(
        contextHandoffCommand({ postMessage }, () => Promise.reject(new Error("boom")))(view)
      ).toBe(true);
      await flushMicrotasks();
      expect(postMessage).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
      view.destroy();
    }
  });

  it("does not post when the view was destroyed while it waited", async () => {
    let release!: (ok: boolean) => void;
    const settle = () =>
      new Promise<boolean>((r) => {
        release = r;
      });
    const postMessage = vi.fn();
    const view = new EditorView({ state: stateWith(6, 20), parent: document.body });
    contextHandoffCommand({ postMessage }, settle)(view);
    view.destroy();
    release(true); // a settle that did not notice the teardown
    await flushMicrotasks();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("captures the selection after the wait, not before", async () => {
    let release!: (ok: boolean) => void;
    const settle = () =>
      new Promise<boolean>((r) => {
        release = r;
      });
    const postMessage = vi.fn();
    const view = new EditorView({ state: stateWith(0, 3), parent: document.body }); // line 1
    try {
      contextHandoffCommand({ postMessage }, settle)(view);
      view.dispatch({ selection: EditorSelection.single(12, 20) }); // lines 3-4
      release(true);
      await flushMicrotasks();
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ hasSelection: true, startLine: 3, endLine: 4 })
      );
    } finally {
      view.destroy();
    }
  });

  it("returns true even when postMessage throws (chord is claimed)", async () => {
    const postMessage = vi.fn(() => {
      throw new Error("transport gone");
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: stateWith(0, 0), parent });
    try {
      expect(contextHandoffCommand({ postMessage }, settled)(view)).toBe(true);
      await flushMicrotasks(); // the post runs, and its throw stays inside
      expect(postMessage).toHaveBeenCalledTimes(1);
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
  it("posts a codex-context-handoff envelope with no selection geometry", async () => {
    const postMessage = vi.fn();
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    // Selection present — must NOT leak into the Codex message (whole-file).
    const view = new EditorView({ state: stateWith(6, 20), parent });
    try {
      const handled = codexContextHandoffCommand({ postMessage }, settled)(view);
      expect(handled).toBe(true);
      await flushMicrotasks();
      expect(postMessage).toHaveBeenCalledWith({
        protocol: PROTOCOL_VERSION,
        type: "codex-context-handoff",
      });
    } finally {
      view.destroy();
    }
  });

  it("posts only after settle resolves true", async () => {
    let release!: (ok: boolean) => void;
    const settle = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          release = r;
        })
    );
    const postMessage = vi.fn();
    const view = new EditorView({ state: stateWith(6, 20), parent: document.body });
    try {
      expect(codexContextHandoffCommand({ postMessage }, settle)(view)).toBe(true);
      expect(settle).toHaveBeenCalledTimes(1); // synchronously, inside the key dispatch
      await flushMicrotasks();
      expect(postMessage).not.toHaveBeenCalled();
      release(true);
      await flushMicrotasks();
      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "codex-context-handoff" })
      );
    } finally {
      view.destroy();
    }
  });

  it("does not post when settle resolves false (unsynced / cancelled)", async () => {
    const postMessage = vi.fn();
    const view = new EditorView({ state: stateWith(6, 20), parent: document.body });
    try {
      expect(codexContextHandoffCommand({ postMessage }, async () => false)(view)).toBe(true);
      await flushMicrotasks();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("does not post, and does not throw, when settle throws or rejects", async () => {
    const postMessage = vi.fn();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = new EditorView({ state: stateWith(6, 20), parent: document.body });
    try {
      const throws = () => {
        throw new Error("boom");
      };
      expect(codexContextHandoffCommand({ postMessage }, throws)(view)).toBe(true);
      expect(
        codexContextHandoffCommand({ postMessage }, () => Promise.reject(new Error("boom")))(view)
      ).toBe(true);
      await flushMicrotasks();
      expect(postMessage).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      errorSpy.mockRestore();
      view.destroy();
    }
  });

  it("does not post when the view was destroyed while it waited", async () => {
    let release!: (ok: boolean) => void;
    const settle = () =>
      new Promise<boolean>((r) => {
        release = r;
      });
    const postMessage = vi.fn();
    const view = new EditorView({ state: stateWith(6, 20), parent: document.body });
    codexContextHandoffCommand({ postMessage }, settle)(view);
    view.destroy();
    release(true); // a settle that did not notice the teardown
    await flushMicrotasks();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("returns true even when postMessage throws (chord is claimed)", async () => {
    const postMessage = vi.fn(() => {
      throw new Error("transport gone");
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ state: stateWith(0, 0), parent });
    try {
      expect(codexContextHandoffCommand({ postMessage }, settled)(view)).toBe(true);
      await flushMicrotasks(); // the post runs, and its throw stays inside
      expect(postMessage).toHaveBeenCalledTimes(1);
    } finally {
      view.destroy();
    }
  });
});
