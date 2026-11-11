// @vitest-environment happy-dom
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { NumericEntityWidget } from "../../../src/webview/cm/decorations/numeric-entity-widget.js";

describe("numeric entity widget", () => {
  it("renders decoded text without creating markup", () => {
    const view = new EditorView();
    try {
      for (const value of ["a", "😀", "<", "&", "\u2060"]) {
        const el = new NumericEntityWidget(value, "").toDOM(view);
        expect(el.textContent).toBe(value);
        expect(el.children.length).toBe(0);
        expect(el.tabIndex).toBe(-1);
        expect(el.className).toBe("quoll-numeric-entity");
      }
      const strong = new NumericEntityWidget("a", "ͼu quoll-tok-strong").toDOM(view);
      expect(strong.className).toBe("quoll-numeric-entity ͼu quoll-tok-strong");
    } finally {
      view.destroy();
    }
  });
  it("compares decoded display values and highlight classes and lets pointer events reach CodeMirror", () => {
    const a = new NumericEntityWidget("a", "");
    expect(a.eq(new NumericEntityWidget("a", ""))).toBe(true);
    expect(a.eq(new NumericEntityWidget("b", ""))).toBe(false);
    expect(a.eq(new NumericEntityWidget("a", "quoll-tok-strong"))).toBe(false);
    expect(a.ignoreEvent()).toBe(false);
  });
});
