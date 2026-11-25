// @vitest-environment happy-dom
// A task marker on the line AFTER its ListMark (`-\n  [ ] foo`, `-\n  [ ]` —
// the @lezer/markdown >= 1.7.2 shape of an item whose marker line is empty).
// The checkbox replace [ListMark.from, TaskMarker.to) would span a line break,
// which the decoration orchestrator rejects by dropping the WHOLE checkbox
// provider — so every other checkbox in the viewport reverted to raw source.
// Contract: such an item renders no checkbox, and its siblings keep theirs.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { quollSyntaxReveal } from "../../../src/webview/cm/decorations/index.js";
import { toggleTaskCheckboxAtCaret } from "../../../src/webview/cm/task-checkbox/task-checkbox-command.js";
import { taskCheckboxReveal } from "../../../src/webview/cm/task-checkbox/task-checkbox-reveal.js";
import { fullTree } from "../helpers/full-tree.js";
import { settledMount } from "../helpers/settled-view.js";

const DOCS = [
  "- [ ] other\n\n-\n  [ ] foo\n\npara",
  "- [ ] other\n\n-\n  [ ]\n\npara",
  // A Task in a later paragraph of the item, not on its marker line.
  "- [ ] other\n\n- a\n\n  [ ] b\n\npara",
];

describe("task marker on the line after the ListMark", () => {
  it.each(DOCS)("provider emits no replace crossing a line break (%j)", (doc) => {
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
      selection: EditorSelection.single(doc.length),
    });
    const set = taskCheckboxReveal.build({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: doc.length }],
      tree: fullTree(state),
    });
    const iter = set.iter();
    while (iter.value !== null) {
      expect(state.doc.sliceString(iter.from, iter.to)).not.toContain("\n");
      iter.next();
    }
  });

  it.each(DOCS)("the sibling `- [ ] other` still renders its checkbox (%j)", (doc) => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = settledMount({
      parent,
      state: EditorState.create({
        doc,
        selection: EditorSelection.single(doc.length),
        extensions: [markdown({ base: markdownLanguage }), quollSyntaxReveal()],
      }),
    });
    try {
      // Re-run the decoration build against the settled tree.
      view.dispatch({ selection: EditorSelection.single(doc.length - 1) });
      expect(view.dom.querySelectorAll(".quoll-task-checkbox").length).toBe(1);
    } finally {
      view.destroy();
    }
  });
});

// An ORDERED Task off the marker line replaces only its own `[ ]` (the `N. `
// stays visible), a single-line span — so unlike the bullet shapes above it
// keeps the checkbox and the Mod-L toggle it had on main (@lezer/markdown 1.6.4).
describe("ordered Task in a later paragraph (`1. a\\n\\n   [ ] b`)", () => {
  const doc = "1. a\n\n   [ ] b\n\npara";
  const marker = doc.indexOf("[ ]");

  function mount(caret: number) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    return settledMount({
      parent,
      state: EditorState.create({
        doc,
        selection: EditorSelection.single(caret),
        extensions: [markdown({ base: markdownLanguage }), quollSyntaxReveal()],
      }),
    });
  }

  it("renders its checkbox (caret off the task line)", () => {
    const view = mount(doc.length);
    try {
      view.dispatch({ selection: EditorSelection.single(doc.length - 1) });
      expect(view.dom.querySelectorAll(".quoll-task-checkbox").length).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("Mod-L toggle at a caret on the task line checks it", () => {
    const view = mount(marker + 4);
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n\n   [x] b\n\npara");
    } finally {
      view.destroy();
    }
  });
});
