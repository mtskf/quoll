// @vitest-environment happy-dom
// test/webview/fenced-code/cm-fenced-collapse-fold.test.ts
//
// The shared collapse reducer reacts to the fold set (an outer heading fold). This pins
// that the FENCED client keeps its auto-expand through that change: a jump into a
// concealed line of a collapsed fence inside a folded section unfolds AND expands it.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldable, foldEffect, foldedRanges } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fencedCodeCollapseField } from "../../../src/webview/cm/fenced-code/fenced-code-collapse.js";
import { quollFolding } from "../../../src/webview/cm/fold/index.js";
import { settledMount } from "../helpers/settled-view.js";

describe("fencedCodeCollapseField — outer fold", () => {
  it("8. a jump into the concealed body of a collapsed fence under a folded heading unfolds AND expands", () => {
    const body = Array.from({ length: 14 }, (_, i) => `code ${i + 1}`).join("\n");
    const doc = `# H\n\n\`\`\`js\n${body}\n\`\`\`\n`;
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = settledMount({
      state: EditorState.create({
        doc,
        selection: EditorSelection.single(0),
        extensions: [markdown({ base: markdownLanguage }), quollFolding(), fencedCodeCollapseField],
      }),
      parent,
    });
    try {
      const before = view.state.field(fencedCodeCollapseField);
      expect(before.blocks).toHaveLength(1);
      expect(before.blocks[0].expanded).toBe(false);

      const h = view.state.doc.line(1);
      const range = foldable(view.state, h.from, h.to);
      if (range === null) {
        throw new Error("heading does not fold");
      }
      view.dispatch({ effects: foldEffect.of(range) });
      expect(foldedRanges(view.state).size).toBe(1);

      // Fence opens on line 3; body line 14 of 14 is well inside the concealed tail.
      const target = view.state.doc.line(3 + 14).from;
      view.dispatch({ selection: { anchor: target } });

      expect(foldedRanges(view.state).size).toBe(0);
      const after = view.state.field(fencedCodeCollapseField);
      expect(after.blocks[0].expanded).toBe(true);
      const head = view.state.selection.main.head;
      const covered = after.blocks.some(
        (b) => !b.expanded && b.decoFrom < b.decoTo && head >= b.decoFrom && head <= b.decoTo
      );
      expect(covered).toBe(false);
    } finally {
      view.destroy();
    }
  });
});
