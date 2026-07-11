// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { editorPrefsApply } from "../../src/webview/cm/editor-prefs-apply.js";
import { editorPrefsField, setEditorPrefsEffect } from "../../src/webview/cm/editor-prefs.js";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.textContent = "";
});

function mount(): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({ extensions: [editorPrefsField, editorPrefsApply()] }),
  });
  return view;
}

describe("editorPrefsApply", () => {
  it("sets no inline vars at the defaults (today's rendering preserved)", () => {
    const v = mount();
    expect(v.dom.style.getPropertyValue("--quoll-editor-font-family")).toBe("");
    expect(v.dom.style.getPropertyValue("--quoll-editor-font-size")).toBe("");
    expect(v.dom.style.getPropertyValue("--quoll-editor-line-height")).toBe("");
    expect(v.dom.style.getPropertyValue("--quoll-editor-content-width")).toBe("");
  });

  it("writes vars for non-default presets and clears them on return to default", () => {
    const v = mount();
    v.dispatch({
      effects: setEditorPrefsEffect.of({
        fontFamily: "serif",
        fontSize: "large",
        lineHeight: "compact",
        contentWidth: "wide",
      }),
    });
    expect(v.dom.style.getPropertyValue("--quoll-editor-font-family")).toBe(
      "Georgia, 'Times New Roman', serif"
    );
    expect(v.dom.style.getPropertyValue("--quoll-editor-font-size")).toBe(
      "calc(var(--vscode-font-size) * 1.15)"
    );
    expect(v.dom.style.getPropertyValue("--quoll-editor-line-height")).toBe("1.5");
    expect(v.dom.style.getPropertyValue("--quoll-editor-content-width")).toBe("75em");

    v.dispatch({
      effects: setEditorPrefsEffect.of({
        fontFamily: "default",
        fontSize: "default",
        lineHeight: "cozy",
        contentWidth: "medium",
      }),
    });
    expect(v.dom.style.getPropertyValue("--quoll-editor-font-family")).toBe("");
    expect(v.dom.style.getPropertyValue("--quoll-editor-content-width")).toBe("");
  });
});
