// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_EDITOR_PREFS,
  editorPrefsField,
  editorPrefToCssValue,
  setEditorPrefsEffect,
} from "../../src/webview/cm/editor-prefs.js";

describe("editorPrefsField", () => {
  it("initialises to the defaults (today's rendering)", () => {
    const state = EditorState.create({ extensions: [editorPrefsField] });
    expect(state.field(editorPrefsField)).toEqual(DEFAULT_EDITOR_PREFS);
    expect(DEFAULT_EDITOR_PREFS).toEqual({
      fontFamily: "default",
      fontSize: "default",
      lineHeight: "cozy",
      contentWidth: "medium",
    });
  });

  it("updates when the setEditorPrefsEffect is dispatched", () => {
    const state = EditorState.create({ extensions: [editorPrefsField] });
    const next = state.update({
      effects: setEditorPrefsEffect.of({
        fontFamily: "serif",
        fontSize: "large",
        lineHeight: "compact",
        contentWidth: "wide",
      }),
    }).state;
    expect(next.field(editorPrefsField)).toEqual({
      fontFamily: "serif",
      fontSize: "large",
      lineHeight: "compact",
      contentWidth: "wide",
    });
  });
});

describe("editorPrefToCssValue", () => {
  it("returns null for a default id (var removed → CSS fallback = today)", () => {
    expect(editorPrefToCssValue("quoll.editor.fontFamily", "default")).toBeNull();
    expect(editorPrefToCssValue("quoll.editor.fontSize", "default")).toBeNull();
    expect(editorPrefToCssValue("quoll.editor.lineHeight", "cozy")).toBeNull();
    expect(editorPrefToCssValue("quoll.editor.contentWidth", "medium")).toBeNull();
  });

  it("maps each non-default id to its concrete CSS value", () => {
    expect(editorPrefToCssValue("quoll.editor.fontFamily", "serif")).toBe(
      "Georgia, 'Times New Roman', serif"
    );
    expect(editorPrefToCssValue("quoll.editor.fontSize", "small")).toBe(
      "calc(var(--vscode-font-size) * 0.9)"
    );
    expect(editorPrefToCssValue("quoll.editor.fontSize", "large")).toBe(
      "calc(var(--vscode-font-size) * 1.15)"
    );
    expect(editorPrefToCssValue("quoll.editor.fontSize", "x-large")).toBe(
      "calc(var(--vscode-font-size) * 1.3)"
    );
    expect(editorPrefToCssValue("quoll.editor.lineHeight", "compact")).toBe("1.5");
    expect(editorPrefToCssValue("quoll.editor.lineHeight", "roomy")).toBe("1.9");
    expect(editorPrefToCssValue("quoll.editor.contentWidth", "narrow")).toBe("45em");
    expect(editorPrefToCssValue("quoll.editor.contentWidth", "wide")).toBe("75em");
  });
});
