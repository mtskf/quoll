// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { requireQuollEditorHost } from "../../src/webview/cm/editor-host.js";

describe("requireQuollEditorHost", () => {
  it("returns the nearest .quoll-editor host element", () => {
    const host = document.createElement("div");
    host.className = "quoll-editor";
    const view = new EditorView({ state: EditorState.create({ doc: "" }), parent: host });
    expect(requireQuollEditorHost(view, "quollTest")).toBe(host);
    view.destroy();
  });
  it("throws a context-prefixed error when no host is present", () => {
    const view = new EditorView({ state: EditorState.create({ doc: "" }) });
    expect(() => requireQuollEditorHost(view, "quollTest")).toThrow(
      "quollTest: EditorView must be mounted inside a .quoll-editor host"
    );
    view.destroy();
  });
});
