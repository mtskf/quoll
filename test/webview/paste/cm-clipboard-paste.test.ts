// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";

import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import {
  createClipboardPaste,
  snapshotClipboard,
} from "../../../src/webview/cm/paste/clipboard-paste.js";
import { pendingPasteOperations } from "../../../src/webview/cm/paste/paste-operation.js";
import { firePasteAt, makeClipboardData } from "../helpers/clipboard-double.js";

it("all obtainable Files become transfer candidates", () => {
  const files = [
    new File(["png"], "a", { type: "image/png" }),
    new File(["pdf"], "b", { type: "application/pdf" }),
    new File(["unknown"], "c"),
    new File([], "d", { type: "image/png" }),
  ];
  const data = makeClipboardData({
    text: "",
    html: "<p>caption</p>",
    files: [...files.map((file) => ({ type: file.type, file })), { type: "image/png", file: null }],
  });
  const getters = data.items.map((item) => vi.spyOn(item, "getAsFile"));
  const snapshot = snapshotClipboard(data as unknown as DataTransfer);
  expect(snapshot.files).toEqual(files);
  expect(snapshot.plain).toEqual({ present: true, value: "" });
  expect(snapshot.uri).toEqual({ present: false, value: "" });
  expect(snapshot.html).toEqual({ present: true, value: "<p>caption</p>" });
  getters.forEach((getter, index) => {
    expect(getter).toHaveBeenCalledTimes(data.items[index].kind === "file" ? 1 : 0);
  });
});

const views: EditorView[] = [];
afterEach(() => {
  views.forEach((view) => {
    view.destroy();
  });
  views.length = 0;
  vi.restoreAllMocks();
});
function mount(doc = "", anchor = 0, head = anchor) {
  const post = vi.fn();
  const onFailure = vi.fn();
  const paste = createClipboardPaste({ canWrite: () => true, post, onFailure });
  let edits = 0;
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor, head },
      extensions: [
        quollMarkdownLanguage(),
        paste.extension,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            edits++;
          }
        }),
      ],
    }),
  });
  views.push(view);
  return { view, paste, post, onFailure, edits: () => edits };
}
it("ordinary text-only paste delegates once to CM", () => {
  const { view, post, edits } = mount("hello", 5);
  firePasteAt(view.contentDOM, { text: " world" });
  expect(view.state.doc.toString()).toBe("hello world");
  expect(edits()).toBe(1);
  expect(post).not.toHaveBeenCalled();
});

it("table and File produce one decided table replacement", async () => {
  const { view, paste, post, edits } = mount();
  firePasteAt(view.contentDOM, {
    html: "<table><tr><th>A</th></tr><tr><td>B</td></tr></table>",
    text: "wrong plain",
    files: [{ type: "image/png" }],
  });
  expect(edits()).toBe(0);
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  paste.resolve(post.mock.calls[0][0].requestId, "./assets/a.png");
  expect(view.state.doc.toString()).toBe("| A |\n| --- |\n| B |\n![](./assets/a.png)\n");
  expect(edits()).toBe(1);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});

it("URL and File preserve selected label in one replacement", async () => {
  const { view, paste, post, edits } = mount("label", 0, 5);
  firePasteAt(view.contentDOM, { text: "https://example.com", files: [{ type: "image/png" }] });
  expect(edits()).toBe(0);
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  paste.resolve(post.mock.calls[0][0].requestId, "./assets/a.png");
  expect(view.state.doc.toString()).toBe("[label](https://example.com)\n![](./assets/a.png)\n");
  expect(edits()).toBe(1);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});

async function pendingUrl() {
  const mounted = mount("label", 0, 5);
  firePasteAt(mounted.view.contentDOM, {
    text: "https://example.com",
    files: [{ type: "image/png" }],
  });
  await vi.waitFor(() => expect(mounted.post).toHaveBeenCalledTimes(1));
  return { ...mounted, requestId: mounted.post.mock.calls[0][0].requestId as string };
}
it("pending URL wrap rechecks live syntax", async () => {
  const { view, paste, requestId, edits } = await pendingUrl();
  view.dispatch({
    changes: [
      { from: 0, insert: "[" },
      { from: 5, insert: "](https://outer.example)" },
    ],
  });
  paste.resolve(requestId, null);
  expect(view.state.doc.toString()).toBe("[https://example.com](https://outer.example)");
  expect(edits()).toBe(2);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});

it("pending URL fallback retains accepted image", async () => {
  const { view, paste, requestId, edits } = await pendingUrl();
  view.dispatch({
    changes: [
      { from: 0, insert: "[" },
      { from: 5, insert: "](https://outer.example)" },
    ],
  });
  paste.resolve(requestId, "./assets/a.png");
  expect(view.state.doc.toString()).toBe(
    "[https://example.com\n![](./assets/a.png)\n](https://outer.example)"
  );
  expect(edits()).toBe(2);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});

it("pending URL falls back after outside fence insertion", async () => {
  const { view, paste, requestId } = await pendingUrl();
  view.dispatch({ changes: { from: 0, insert: "```\n" } });
  paste.resolve(requestId, null);
  expect(view.state.doc.toString()).toBe("```\nhttps://example.com");
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});

it("unrelated prose edit retains valid pending URL wrapping", async () => {
  const { view, paste, post } = mount("label\n\n`code`", 0, 5);
  firePasteAt(view.contentDOM, { text: "https://example.com", files: [{ type: "image/png" }] });
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  view.dispatch({
    changes: { from: 0, insert: "prefix\n\n" },
    selection: { anchor: 16, head: 20 },
  });
  paste.resolve(post.mock.calls[0][0].requestId, null);
  expect(view.state.doc.toString()).toBe("prefix\n\n[label](https://example.com)\n\n`code`");
  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
    "code"
  );
});

it.each([
  null,
  "./assets/a.png",
])("list fragment + File with leading whitespace (%s)", async (path) => {
  const { view, paste, post, edits } = mount("- a\n  - b\n  \n  more", 12);
  firePasteAt(view.contentDOM, { text: "- x\n  - y\n- z", files: [{ type: "image/png" }] });
  expect(edits()).toBe(0);
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  expect(view.state.field(pendingPasteOperations)[0]).toMatchObject({ from: 10, to: 12 });
  paste.resolve(post.mock.calls[0][0].requestId, path);
  expect(view.state.doc.toString()).toBe(
    `- a\n  - b\n  - x\n    - y\n  - z${path ? "\n![](./assets/a.png)\n" : ""}\n  more`
  );
  expect(edits()).toBe(1);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});

it("rich syntax and File survive in one insertion", async () => {
  const { view, paste, post, edits } = mount();
  firePasteAt(view.contentDOM, {
    html: "<p><strong>bold</strong></p>",
    text: "bold",
    files: [{ type: "image/png" }],
  });
  expect(edits()).toBe(0);
  await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  paste.resolve(post.mock.calls[0][0].requestId, "./assets/a.png");
  expect(view.state.doc.toString()).toBe("**bold**\n![](./assets/a.png)\n");
  expect(edits()).toBe(1);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});

it.each([
  false,
  true,
])("syntax-bearing HTML yields to applicable URL plain over selection (%s)", async (withFile) => {
  const { view, paste, post, edits } = mount("label", 0, 5);
  firePasteAt(view.contentDOM, {
    html: "<p><strong>rich</strong></p>",
    text: "https://example.com",
    files: withFile ? [{ type: "image/png" }] : [],
  });
  if (withFile) {
    expect(edits()).toBe(0);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    paste.resolve(post.mock.calls[0][0].requestId, "./assets/a.png");
  }
  expect(view.state.doc.toString()).toBe(
    `[label](https://example.com)${withFile ? "\n![](./assets/a.png)\n" : ""}`
  );
  expect(edits()).toBe(1);
  expect(post).toHaveBeenCalledTimes(withFile ? 1 : 0);
});

it.each([
  false,
  true,
])("syntax-bearing HTML yields to applicable list plain at eligible blank line (%s)", async (withFile) => {
  const { view, paste, post, edits } = mount("- a\n  - b\n  \n  more", 12);
  firePasteAt(view.contentDOM, {
    html: "<p><strong>rich</strong></p>",
    text: "- x\n  - y\n- z",
    files: withFile ? [{ type: "image/png" }] : [],
  });
  if (withFile) {
    expect(edits()).toBe(0);
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    paste.resolve(post.mock.calls[0][0].requestId, "./assets/a.png");
  }
  expect(view.state.doc.toString()).toBe(
    `- a\n  - b\n  - x\n    - y\n  - z${withFile ? "\n![](./assets/a.png)\n" : ""}\n  more`
  );
  expect(edits()).toBe(1);
  expect(post).toHaveBeenCalledTimes(withFile ? 1 : 0);
});

async function pendingRich(text?: string) {
  const mounted = mount("target", 0, 6);
  firePasteAt(mounted.view.contentDOM, {
    html: "<p><strong>rich</strong></p>",
    text,
    files: [{ type: "image/png" }],
  });
  await vi.waitFor(() => expect(mounted.post).toHaveBeenCalledTimes(1));
  mounted.view.dispatch({ changes: { from: 0, insert: "```\n" } });
  return { ...mounted, requestId: mounted.post.mock.calls[0][0].requestId as string };
}
it("rich prose-to-code fallback retains accepted image", async () => {
  const { view, paste, requestId, edits } = await pendingRich("captured");
  paste.resolve(requestId, "./assets/a.png");
  expect(view.state.doc.toString()).toBe("```\ncaptured\n![](./assets/a.png)\n");
  expect(edits()).toBe(2);
  expect(view.state.field(pendingPasteOperations)).toEqual([]);
});
