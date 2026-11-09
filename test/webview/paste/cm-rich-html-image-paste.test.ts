// @vitest-environment happy-dom
import { history, redo, redoDepth, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import type { WebviewToHost } from "../../../src/shared/protocol.js";
import { createClipboardPaste } from "../../../src/webview/cm/paste/clipboard-paste.js";
import { pendingPasteOperations } from "../../../src/webview/cm/paste/paste-operation.js";
import { firePasteAt, IMAGE_FILE, makeClipboardData } from "../helpers/clipboard-double.js";
import { imageWrites } from "../helpers/image-paste-doubles.js";

const views: EditorView[] = [];
afterEach(() => {
  views.forEach((view) => {
    view.destroy();
  });
  views.length = 0;
  vi.restoreAllMocks();
});
function mount(doc = "") {
  const post = vi.fn<(message: WebviewToHost) => void>();
  const paste = createClipboardPaste({ canWrite: () => true, post, onFailure: vi.fn() });
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: doc.length },
      extensions: [history(), paste.extension],
    }),
  });
  views.push(view);
  return { view, paste, post };
}
it.each([false, true])("caption and accepted image settle together (plain=%s)", async (plain) => {
  const { view, paste, post } = mount();
  firePasteAt(view.contentDOM, {
    html: "<div>caption</div>",
    ...(plain ? { text: "caption" } : {}),
    files: IMAGE_FILE,
  });
  expect(view.state.doc.toString()).toBe("");
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
  paste.resolve(imageWrites(post)[0].requestId, "assets/a.png");
  expect(view.state.doc.toString()).toBe("caption\n![](assets/a.png)\n");
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
  expect(undo(view)).toBe(true);
  expect(view.state.doc.toString()).toBe("");
  expect(redo(view)).toBe(true);
  expect(imageWrites(post)).toHaveLength(1);
});
it.each([false, true])("caption survives host rejection (zero-byte=%s)", async (empty) => {
  const { view, paste, post } = mount();
  firePasteAt(view.contentDOM, {
    html: "<div>caption</div>",
    files: empty ? [{ type: "image/png", file: new File([], "empty.png") }] : IMAGE_FILE,
  });
  expect(view.state.doc.toString()).toBe("");
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
  paste.resolve(imageWrites(post)[0].requestId, null);
  expect(view.state.doc.toString()).toBe("caption\n");
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});
for (const [name, html] of [
  ["rich pending paste preserves redo", "<p><strong>caption</strong></p>"],
  ["image-only pending paste preserves redo", undefined],
] as const) {
  it(name, async () => {
    const { view, paste, post } = mount("intro\n");
    view.dispatch({
      changes: { from: 6, insert: "typed\n" },
      selection: { anchor: 12 },
      userEvent: "input.type",
    });
    firePasteAt(view.contentDOM, { html, files: IMAGE_FILE });
    await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("intro\n");
    expect(redoDepth(view.state)).toBe(1);
    expect(view.state.field(pendingPasteOperations)).toEqual([]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    paste.resolve(imageWrites(post)[0].requestId, "assets/late.png");
    expect(view.state.doc.toString()).toBe("intro\n");
    expect(redoDepth(view.state)).toBe(1);
    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("intro\ntyped\n");
  });
}
it("no-op undo leaves clipboard pending", async () => {
  const { view, paste, post } = mount();
  firePasteAt(view.contentDOM, { files: IMAGE_FILE });
  expect(undo(view)).toBe(false);
  expect(view.state.field(pendingPasteOperations)).toHaveLength(1);
  await vi.waitFor(() => expect(imageWrites(post)).toHaveLength(1));
  paste.resolve(imageWrites(post)[0].requestId, "assets/a.png");
  expect(view.state.doc.toString()).toBe("![](assets/a.png)\n");
});
it("clipboard snapshot acquires stable File references", () => {
  const supplied = new File(["given"], "given.png", { type: "image/png" });
  const data = makeClipboardData({
    text: "caption",
    files: [
      ...IMAGE_FILE,
      { type: "image/png", file: supplied },
      { type: "image/png", file: null },
      { type: "image/png", file: undefined },
    ],
  });
  const items = data.items.filter((item) => item.kind === "file");
  expect(items[0].getAsFile()).toBe(items[0].getAsFile());
  expect(items[0].getAsFile()).toBe(data.files[0]);
  expect(items[1].getAsFile()).toBe(supplied);
  expect(items[2].getAsFile()).toBeNull();
  expect(items[3].getAsFile()).toBeUndefined();
});
