// These state-only tests pin the fold contract via foldable() against upstream
// markdown({ base }) as a REFERENCE ORACLE — no Quoll language is built here.
// Heading folds are Quoll's re-implementation of lang-markdown's headerIndent
// foldService (cm/markdown.ts); its byte-identical parity against this same oracle
// is asserted in cm-markdown-language.test.ts's headerIndent describe.
// List folds are NOT delegated wholesale: nonFoldableBlocks registers
// `ListItem: listItemFold` (cm/markdown.ts), which reproduces lang-markdown's default
// Block range EXCEPT when the item's first content child is a GFM table that starts on
// the marker line AND emits a block widget — there it returns null. Both arms are
// pinned against quollMarkdownLanguage() itself, not here: the null arm by
// cm-fold-blockquote.test.ts (along with the Table subtraction — tables fold in this
// upstream oracle but NOT in quollMarkdownLanguage), the surviving range by
// cm-markdown-language.test.ts's "re-implemented listItemFold folds list items
// byte-identically to upstream" describe. No view is mounted, so no happy-dom pragma
// is needed.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeFolding, foldable, foldEffect, foldedRanges } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { settledState } from "../helpers/settled-state.js";

// A SETTLED state: `foldable()` resolves in the language field's tree snapshot, which
// a bare `ensureSyntaxTree` leaves truncated — under CPU preemption a fold query then
// returns a spurious `null`. See ../helpers/settled-state.ts and the non-vacuity guard
// in cm-fold-blockquote.test.ts.
function stateFor(doc: string): EditorState {
  return settledState(
    EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), codeFolding()],
    })
  );
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

describe("list folding matches lang-markdown's default Block fallback (upstream oracle)", () => {
  // Upstream only: stateFor mounts markdown({ base: markdownLanguage }), never
  // quollMarkdownLanguage. lang-markdown's `isList(type)` excludes only the
  // BulletList/OrderedList CONTAINERS — not ListItem. ListItem is a "Block", so
  // foldNodeProp folds it to the item end. quollMarkdownLanguage's listItemFold
  // override reproduces that range — pinned against this same upstream oracle in
  // cm-markdown-language.test.ts — except for the marker-line table shape stated in
  // this file's header comment, which is pinned in cm-fold-blockquote.test.ts.
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
