// @vitest-environment happy-dom
import { history, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";

import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import { createClipboardPaste } from "../../../src/webview/cm/paste/clipboard-paste.js";
import { pendingPasteOperations } from "../../../src/webview/cm/paste/paste-operation.js";
import { firePasteAt } from "../helpers/clipboard-double.js";

const views: EditorView[] = [];
afterEach(() => {
  views.forEach((view) => {
    view.destroy();
  });
  views.length = 0;
  vi.restoreAllMocks();
});

function mount(
  options: {
    doc?: string;
    anchor?: number;
    head?: number;
    focused?: boolean;
    readOnly?: boolean;
    canWrite?: boolean;
  } = {}
) {
  const post = vi.fn();
  const paste = createClipboardPaste({
    canWrite: () => options.canWrite ?? true,
    post,
    onFailure: vi.fn(),
    onUnlinkedPath: vi.fn(),
  });
  const view = new EditorView({
    state: EditorState.create({
      doc: options.doc ?? "word",
      selection: { anchor: options.anchor ?? 0, head: options.head ?? 4 },
      extensions: [
        quollMarkdownLanguage(),
        history(),
        EditorState.readOnly.of(options.readOnly ?? false),
        paste.extension,
      ],
    }),
  });
  Object.defineProperty(view, "hasFocus", {
    get: () => options.focused ?? true,
    configurable: true,
  });
  views.push(view);
  return { view, paste, post };
}

it("plain URL paste replaces the selection while DOM paste wraps it", () => {
  const plain = mount();
  plain.paste.pastePlain(plain.view, "https://example.com");
  expect(plain.view.state.doc.toString()).toBe("https://example.com");
  expect(plain.post).not.toHaveBeenCalled();

  const dom = mount();
  firePasteAt(dom.view.contentDOM, { text: "https://example.com" });
  expect(dom.view.state.doc.toString()).toBe("[word](https://example.com)");
});

it("inserts list-shaped text verbatim in an indented list", () => {
  const { view, paste } = mount({ doc: "- outer\n  ", anchor: 10, head: 10 });
  paste.pastePlain(view, "- a\n- b");
  expect(view.state.doc.toString()).toBe("- outer\n  - a\n- b");
});

it.each([
  { readOnly: true },
  { canWrite: false },
  { focused: false },
])("preserves the document and selection when %j", (options) => {
  const { view, paste, post } = mount(options);
  const selection = view.state.selection;
  paste.pastePlain(view, "https://example.com");
  expect(view.state.doc.toString()).toBe("word");
  expect(view.state.selection.eq(selection)).toBe(true);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
  expect(post).not.toHaveBeenCalled();
});

it("one undo restores the document and selection", () => {
  const { view, paste } = mount();
  const selection = view.state.selection;
  paste.pastePlain(view, "- a\n- b");
  expect(view.state.doc.toString()).toBe("- a\n- b");
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("word");
  expect(view.state.selection.eq(selection)).toBe(true);
  expect(undo(view)).toBe(false);
});

it("plain paste cancels an overlapping pending image paste", async () => {
  const { view, paste, post } = mount();
  firePasteAt(view.contentDOM, {
    text: "https://example.com",
    files: [{ type: "image/png" }],
  });
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const requestId = post.mock.calls[0][0].requestId;
  expect(view.state.field(pendingPasteOperations)).toMatchObject([{ from: 0, to: 4 }]);
  expect(view.state.doc.toString()).toBe("word");

  paste.pastePlain(view, "plain");
  expect(view.state.doc.toString()).toBe("plain");
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
  paste.resolve(requestId, "./assets/late.png");
  expect(view.state.doc.toString()).toBe("plain");
  expect(post).toHaveBeenCalledTimes(1);
});
