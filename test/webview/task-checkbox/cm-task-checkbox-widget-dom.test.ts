// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { toggleTaskCheckbox } from "../../../src/webview/cm/task-checkbox/task-checkbox-command.js";
import { CheckboxWidget } from "../../../src/webview/cm/task-checkbox/task-checkbox-widget.js";

function mountView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return new EditorView({ state, parent });
}

describe("CheckboxWidget — DOM + a11y", () => {
  it('renders <span role="checkbox"> with tabindex=0', () => {
    const view = mountView("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      expect(el.tagName).toBe("SPAN");
      expect(el.getAttribute("role")).toBe("checkbox");
      expect(el.getAttribute("tabindex")).toBe("0");
    } finally {
      view.destroy();
    }
  });

  it("aria-checked reflects checked state", () => {
    const view = mountView("- [x] alpha");
    try {
      const checked = new CheckboxWidget(true, 2, "alpha").toDOM(view);
      const unchecked = new CheckboxWidget(false, 2, "beta").toDOM(view);
      expect(checked.getAttribute("aria-checked")).toBe("true");
      expect(unchecked.getAttribute("aria-checked")).toBe("false");
    } finally {
      view.destroy();
    }
  });

  it("aria-label includes the trimmed task body", () => {
    const view = mountView("- [ ] Finish the report");
    try {
      const el = new CheckboxWidget(false, 2, "Finish the report").toDOM(view);
      expect(el.getAttribute("aria-label")).toContain("Finish the report");
    } finally {
      view.destroy();
    }
  });

  it("carries .quoll-task-checkbox class and data-checked attribute", () => {
    const view = mountView("- [ ] alpha");
    try {
      const el = new CheckboxWidget(true, 2, "alpha").toDOM(view);
      expect(el.classList.contains("quoll-task-checkbox")).toBe(true);
      expect(el.dataset.checked).toBe("true");
    } finally {
      view.destroy();
    }
  });

  it("eq() returns true when checked + from match (label deliberately excluded)", () => {
    const a = new CheckboxWidget(true, 5, "foo");
    const b = new CheckboxWidget(true, 5, "bar");
    expect(a.eq(b)).toBe(true);
  });

  it("eq() returns false when checked differs", () => {
    const a = new CheckboxWidget(false, 5, "foo");
    const b = new CheckboxWidget(true, 5, "foo");
    expect(a.eq(b)).toBe(false);
  });

  it("eq() returns false when from differs", () => {
    const a = new CheckboxWidget(true, 5, "foo");
    const b = new CheckboxWidget(true, 9, "foo");
    expect(a.eq(b)).toBe(false);
  });

  it("ignoreEvent returns true so CodeMirror does not consume widget events", () => {
    const a = new CheckboxWidget(false, 2, "alpha");
    // No event is constructed — this override takes no parameter and answers
    // unconditionally: "I handle widget-originated events myself."
    expect(a.ignoreEvent()).toBe(true);
  });
});

describe("toggleTaskCheckbox — content-less checkboxes", () => {
  it("toggles a content-less `- [ ]` → `- [x]` (no TaskMarker node exists)", () => {
    const view = mountView("- [ ]");
    try {
      expect(toggleTaskCheckbox(view, 2)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x]");
    } finally {
      view.destroy();
    }
  });

  it("toggles a content-less `- [x]` back to `- [ ]`", () => {
    const view = mountView("- [x]");
    try {
      expect(toggleTaskCheckbox(view, 2)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ]");
    } finally {
      view.destroy();
    }
  });

  it("does NOT toggle a non-first-content `[ ]` paragraph (`- first\\n\\n  [ ]`)", () => {
    const view = mountView("- first\n\n  [ ]");
    try {
      expect(toggleTaskCheckbox(view, 11)).toBe(false); // the trailing `[` is at 11
      expect(view.state.doc.toString()).toBe("- first\n\n  [ ]");
    } finally {
      view.destroy();
    }
  });
});
