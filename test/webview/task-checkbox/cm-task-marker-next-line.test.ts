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
import { taskCheckboxReveal } from "../../../src/webview/cm/task-checkbox/task-checkbox-reveal.js";
import { fullTree } from "../helpers/full-tree.js";
import { settledMount } from "../helpers/settled-view.js";

const DOCS = ["- [ ] other\n\n-\n  [ ] foo\n\npara", "- [ ] other\n\n-\n  [ ]\n\npara"];

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
