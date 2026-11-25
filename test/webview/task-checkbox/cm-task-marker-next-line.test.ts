// @vitest-environment happy-dom
// A Task below its item's ListMark line — `-\n  [ ] foo` (the @lezer/markdown
// >= 1.7.2 shape of an item whose marker line is empty), a later paragraph
// `- a\n\n  [ ] b`, or the ordered `1. a\n\n   [ ] b`. One fold rule covers them
// all: the checkbox replaces only the Task's own `[ ]` (the bullet folds in only
// when it shares the line), so it renders, toggles with Mod-L, and the bullet
// keeps its dot. A replace that crossed a line break would make the decoration
// orchestrator drop the WHOLE checkbox provider (every checkbox in the viewport
// reverted to raw source), so the provider must never emit one — pinned below.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { quollSyntaxReveal } from "../../../src/webview/cm/decorations/index.js";
import { toggleTaskCheckboxAtCaret } from "../../../src/webview/cm/task-checkbox/task-checkbox-command.js";
import { taskCheckboxReveal } from "../../../src/webview/cm/task-checkbox/task-checkbox-reveal.js";
import { fullTree } from "../helpers/full-tree.js";
import { settledMount } from "../helpers/settled-view.js";

function mount(doc: string, caret: number) {
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

// [doc, rendered checkboxes]. The content-less `-\n  [ ]` is a plain paragraph
// (no Task node), so only the sibling renders there.
const DOCS: Array<[string, number]> = [
  ["- [ ] other\n\n-\n  [ ] foo\n\npara", 2],
  ["- [ ] other\n\n-\n  [ ]\n\npara", 1],
  ["- [ ] other\n\n- a\n\n  [ ] b\n\npara", 2],
];

describe("task marker below the ListMark line", () => {
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

  it.each(DOCS)("the sibling `- [ ] other` keeps its checkbox (%j)", (doc, count) => {
    const view = mount(doc, doc.length);
    try {
      // Re-run the decoration build against the settled tree.
      view.dispatch({ selection: EditorSelection.single(doc.length - 1) });
      expect(view.dom.querySelectorAll(".quoll-task-checkbox").length).toBe(count);
    } finally {
      view.destroy();
    }
  });
});

// Bullet and ordered alike: the off-line Task renders its checkbox and Mod-L
// toggles it (the ordered shape had both on main, @lezer/markdown 1.6.4).
describe.each([
  ["-\n  [ ] foo\n\npara", "-\n  [x] foo\n\npara"],
  ["- a\n\n  [ ] b\n\npara", "- a\n\n  [x] b\n\npara"],
  ["1. a\n\n   [ ] b\n\npara", "1. a\n\n   [x] b\n\npara"],
])("Task below the marker line (%j)", (doc, toggled) => {
  const marker = doc.indexOf("[ ]");

  it("renders its checkbox, and a bullet keeps its dot (caret off the task line)", () => {
    const view = mount(doc, doc.length);
    try {
      view.dispatch({ selection: EditorSelection.single(doc.length - 1) });
      expect(view.dom.querySelectorAll(".quoll-task-checkbox").length).toBe(1);
      expect(view.dom.querySelectorAll(".quoll-bullet-marker").length).toBe(
        doc.startsWith("-") ? 1 : 0
      );
    } finally {
      view.destroy();
    }
  });

  it("Mod-L toggle at a caret on the task line checks it", () => {
    const view = mount(doc, marker + 4);
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(toggled);
    } finally {
      view.destroy();
    }
  });
});
