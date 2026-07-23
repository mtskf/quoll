// @vitest-environment happy-dom
import { markdown } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_REF_OPEN_KEY,
  openCodeRefAtCaretCommand,
  tryOpenCodeRefAt,
} from "../../src/webview/cm/code-ref/code-ref-handlers.js";

function stateFor(doc: string, sel?: number) {
  return EditorState.create({
    doc,
    extensions: [markdown()],
    selection: sel === undefined ? undefined : { anchor: sel },
  });
}

describe("tryOpenCodeRefAt", () => {
  it("posts open-code-reference for a path inside inline code", () => {
    const doc = "see `src/foo.ts:42` end";
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor(doc), doc.indexOf("foo"), host as never)).toBe(true);
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
    );
  });
  it("does not post for a non-path or .md inline code span", () => {
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor("call `useState` now"), 8, host as never)).toBe(false);
    expect(tryOpenCodeRefAt(stateFor("see `a/b.md` x"), 6, host as never)).toBe(false);
    expect(host.postMessage).not.toHaveBeenCalled();
  });
  it("does not post for inline code inside a link (link owns the click)", () => {
    const doc = "[`src/foo.ts`](other.md)";
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor(doc), doc.indexOf("foo"), host as never)).toBe(false);
  });
  it("does not post while the selection intersects the span (editing)", () => {
    const doc = "see `src/foo.ts` end";
    const host = { postMessage: vi.fn() };
    expect(
      tryOpenCodeRefAt(stateFor(doc, doc.indexOf("foo")), doc.indexOf("foo"), host as never)
    ).toBe(false);
  });
  it("does not post outside any inline code", () => {
    const host = { postMessage: vi.fn() };
    expect(tryOpenCodeRefAt(stateFor("plain src/foo.ts text"), 2, host as never)).toBe(false);
  });
  it("opens despite an intersecting selection when the defer guard is off (keyboard path)", () => {
    // The keyboard command targets a reference by putting the caret INSIDE it,
    // which self-intersects the span. With deferWhenSelectionIntersects=false the
    // open must still fire (unlike the mouse path pinned above).
    const doc = "see `src/foo.ts:42` end";
    const host = { postMessage: vi.fn() };
    expect(
      tryOpenCodeRefAt(stateFor(doc, doc.indexOf("foo")), doc.indexOf("foo"), host as never, {
        deferWhenSelectionIntersects: false,
      })
    ).toBe(true);
    expect(host.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
    );
  });
});

describe("CODE_REF_OPEN_KEY", () => {
  it("is the Mod-Enter chord", () => {
    // Pin the chord string (the single source of truth for the keymap binding).
    // The real platform-resolved binding is exercised in manual smoke; happy-dom's
    // CM platform detection makes a synthetic-key runScopeHandlers test flaky.
    expect(CODE_REF_OPEN_KEY).toBe("Mod-Enter");
  });
});

describe("openCodeRefAtCaretCommand", () => {
  function viewWithCaret(doc: string, caret: number): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.single(caret),
        extensions: [markdown()],
      }),
      parent,
    });
  }

  it("posts open-code-reference when the caret is inside a reference", () => {
    const doc = "see `src/foo.ts:42` end";
    const host = { postMessage: vi.fn() };
    const view = viewWithCaret(doc, doc.indexOf("foo"));
    try {
      expect(openCodeRefAtCaretCommand(host as never)(view)).toBe(true);
      expect(host.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ type: "open-code-reference", path: "src/foo.ts", line: 42 })
      );
    } finally {
      view.destroy();
    }
  });

  it("returns false and posts nothing when the caret is not in a reference", () => {
    const host = { postMessage: vi.fn() };
    const view = viewWithCaret("plain src/foo.ts text", 2);
    try {
      expect(openCodeRefAtCaretCommand(host as never)(view)).toBe(false);
      expect(host.postMessage).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });
});
