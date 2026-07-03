// These state-only tests pin the DELIVERED fold contract via foldable() against
// upstream markdown({ base }) as a REFERENCE ORACLE. Heading folds are produced by
// Quoll's re-implementation of lang-markdown's headerIndent foldService (see
// cm/markdown.ts); list/block folds still come from lang-markdown's foldNodeProp.
// These tests assert the upstream contract our language must match for headings and
// lists; the direct-build parity is pinned in cm-markdown-language.test.ts. (Tables
// fold in this upstream oracle but NOT in quollMarkdownLanguage — nonFoldableBlocks
// subtracts the Table node so table blocks show no chevron; that divergence is pinned
// in cm-fold-blockquote.test.ts.) No view is mounted, so no happy-dom pragma is needed.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  codeFolding,
  ensureSyntaxTree,
  foldable,
  foldEffect,
  foldedRanges,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

function stateFor(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage }), codeFolding()],
  });
  ensureSyntaxTree(state, state.doc.length, 5000); // force a full sync parse (headless)
  return state;
}

/** foldable() for the line that offset `at` falls on. */
function foldableAt(doc: string, at: number): { from: number; to: number } | null {
  const state = stateFor(doc);
  const line = state.doc.lineAt(at);
  return foldable(state, line.from, line.to);
}

describe("heading folding matches lang-markdown's contract (reference oracle)", () => {
  // Heading fold is Quoll's OWN re-implementation (cm/markdown.ts headerIndent
  // foldService); this suite pins the upstream markdown({ base }) contract it
  // must match as a REFERENCE ORACLE — with the markdown language active, a
  // heading folds to the line before the next same-or-higher heading. (The
  // direct-build parity against quollMarkdownLanguage lives in
  // cm-markdown-language.test.ts.)
  it("a heading folds to the next same-or-higher heading", () => {
    const doc = "# A\nbody1\nbody2\n# B\n";
    const state = stateFor(doc);
    const line = state.doc.lineAt(0); // "# A"
    const r = foldable(state, line.from, line.to);
    expect(r).not.toBeNull();
    expect(r!.from).toBe(line.to); // from end of the heading line
    expect(r!.to).toBe(doc.indexOf("\n# B")); // to = end of "body2"
  });

  it("a higher-level heading folds PAST lower-level subheadings", () => {
    const doc = "# A\n## A1\ntext\n# B\n";
    const state = stateFor(doc);
    const line = state.doc.lineAt(0); // "# A" (level 1)
    const r = foldable(state, line.from, line.to);
    expect(r).not.toBeNull();
    expect(r!.to).toBe(doc.indexOf("\n# B")); // spans the level-2 subheading
  });
});

describe("list folding is delegated to lang-markdown (foldNodeProp Block fallback)", () => {
  // lang-markdown's `isList(type)` excludes only the BulletList/OrderedList
  // CONTAINERS — not ListItem. ListItem is a "Block", so foldNodeProp folds it
  // to the item end. Quoll adds no custom list foldService; foldable() already
  // returns the item-body range.
  it("a nested-list parent item is foldable (folds the item body)", () => {
    const doc = "- a\n  - b\n  - c\n- d\n";
    const r = foldableAt(doc, 0); // on "- a"
    expect(r).not.toBeNull();
    expect(r!.from).toBe(3); // end of "- a" line
  });

  it("a leaf list item is NOT foldable", () => {
    const doc = "- a\n  - b\n  - c\n- d\n";
    const dPos = doc.indexOf("- d");
    expect(foldableAt(doc, dPos)).toBeNull();
  });

  it("a nested child line is NOT foldable (chevron only on the parent)", () => {
    const doc = "- a\n  - b\n  - c\n- d\n";
    const bPos = doc.indexOf("- b");
    expect(foldableAt(doc, bPos)).toBeNull();
  });
});

describe("folding is byte-identical (view-layer only)", () => {
  it("folding a list-item range does not change document bytes", () => {
    const doc = "- a\n  - b\n  - c\n- d\n";
    let state = stateFor(doc);
    const line = state.doc.lineAt(0);
    const r = foldable(state, line.from, line.to);
    expect(r).not.toBeNull();
    state = state.update({ effects: foldEffect.of(r!) }).state;
    expect(foldedRanges(state).size).toBe(1); // the fold is recorded...
    expect(state.sliceDoc()).toBe(doc); // ...but the bytes are untouched.
  });
});
