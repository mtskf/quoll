// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  indentListItem,
  listIndentKeymap,
  outdentListItem,
} from "../../../src/webview/cm/list/list-indent-keymap.js";

function forceParse(view: EditorView): EditorView {
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

function mount(
  doc: string,
  selection: EditorSelection | SelectionRange,
  opts: { readOnly?: boolean; tabSize?: number } = {}
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.readOnly.of(opts.readOnly ?? false),
      ...(opts.tabSize === undefined ? [] : [EditorState.tabSize.of(opts.tabSize)]),
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

function at(view: EditorView, n: number, col = 0): EditorSelection | SelectionRange {
  const line = view.state.doc.line(n);
  return EditorSelection.cursor(Math.min(line.from + col, line.to));
}

// Number of `ListItem` ancestors of line `n`'s first non-whitespace position —
// the item's nesting depth. Re-parses first (the command's dispatch changed the
// doc). Pins ACTUAL structural nesting, not just the whitespace (Codex #2).
function itemDepth(view: EditorView, n: number): number {
  forceParsing(view, view.state.doc.length, 5_000);
  const line = view.state.doc.line(n);
  const wsLen = line.text.length - line.text.trimStart().length;
  let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(
    line.from + wsLen,
    1
  );
  let depth = 0;
  while (node !== null) {
    if (node.name === "ListItem") {
      depth++;
    }
    node = node.parent;
  }
  return depth;
}

describe("indentListItem", () => {
  it("Tab nests a bullet under a preceding ordered item at its content column", () => {
    const view = mount("1. test\n2. test\n- ddd\n3. ddd", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 3, 1) }); // caret in "- ddd"
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. test\n2. test\n   - ddd\n3. ddd");
      expect(itemDepth(view, 3)).toBe(2);
      expect(itemDepth(view, 4)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("nests a bullet under its preceding sibling (2-space marker) — depth 1→2", () => {
    const view = mount("- A\n- B\n- C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(itemDepth(view, 2)).toBe(1); // B starts top-level
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n  - B\n- C");
      expect(itemDepth(view, 2)).toBe(2); // B is now nested under A
    } finally {
      view.destroy();
    }
  });

  it("nests an ordered item by the marker width (3 spaces), resetting to 1 + healing the vacated run", () => {
    const view = mount("1. A\n2. B\n3. C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 3) });
    try {
      expect(indentListItem(view)).toBe(true);
      // 3 spaces — the ONLY indent that parses as nested under "1. A". The new
      // nested run resets to 1 (Notion-style) and the vacated outer run closes
      // its gap (3. C → 2. C), leaving no stale ordinal.
      expect(view.state.doc.toString()).toBe("1. A\n   1. B\n2. C");
      expect(itemDepth(view, 2)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("nests a GFM task-list item under its preceding task sibling", () => {
    const view = mount("- [ ] A\n- [ ] B", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 6) });
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] A\n  - [ ] B");
      expect(itemDepth(view, 2)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("carries nested children along (uniform subtree shift)", () => {
    const view = mount("- A\n- B\n  - C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n  - B\n    - C");
      expect(itemDepth(view, 2)).toBe(2); // B nested under A
      expect(itemDepth(view, 3)).toBe(3); // C still one deeper than B
    } finally {
      view.destroy();
    }
  });

  it("nests when the caret is at END of the item line (side-forward misresolve guard)", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) });
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n  - B");
    } finally {
      view.destroy();
    }
  });

  it("skips a whitespace-only interior line of a loose item", () => {
    const view = mount("- A\n- B\n   \n  more", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.line(2).text).toBe("  - B");
      expect(view.state.doc.line(3).text).toBe("   "); // untouched
      expect(view.state.doc.line(4).text).toBe("    more");
    } finally {
      view.destroy();
    }
  });

  it("is a no-op (returns true) on the FIRST item — nothing to nest under", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 1, 2) });
    try {
      expect(indentListItem(view)).toBe(true); // swallowed, no focus escape
      expect(view.state.doc.toString()).toBe("- A\n- B"); // unchanged
    } finally {
      view.destroy();
    }
  });

  it("is a no-op (returns true) in a plain paragraph — swallowed, focus does not escape", () => {
    const view = mount("just a paragraph", EditorSelection.cursor(4));
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("just a paragraph");
    } finally {
      view.destroy();
    }
  });

  it("is a no-op (returns true) inside a fenced code block, even nested in a list", () => {
    const doc = "- A\n  ```\n  code\n  ```";
    const view = mount(doc, EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from) }); // leading spaces of fence
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("returns false on a read-only doc (view-mode focus nav)", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0), { readOnly: true });
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(indentListItem(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("- A\n- B");
    } finally {
      view.destroy();
    }
  });

  // (a) heals a broken 2-space nested item: only the marker line moves to col 3;
  //     the lazy tail (flush-left "3. ddd\n4. ddd") is NOT dragged.
  it("(a) heals a broken 2-space doc — only the marker line shifts, lazy tail stays", () => {
    const view = mount("1. a\n2. b\n  - ddd\n3. ddd\n4. ddd", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 3, 3) }); // caret in "  - ddd"
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n2. b\n   - ddd\n3. ddd\n4. ddd");
      expect(itemDepth(view, 3)).toBe(2); // "- ddd" nested under "2. b"
      expect(itemDepth(view, 4)).toBe(1); // "3. ddd" a top-level sibling again
      expect(itemDepth(view, 5)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  // (b) joining an EXISTING nested run adopts its style + continues numbering.
  it("(b) Tab joining an existing nested ordered run continues its numbering", () => {
    const view = mount("1. p\n   1. a\n2. b\n3. c", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 3, 3) }); // caret in "2. b"
    try {
      expect(indentListItem(view)).toBe(true);
      // "2. b" joins the "1. a" child run as "2. b" at col 3; vacated "3. c" → "2. c".
      expect(view.state.doc.toString()).toBe("1. p\n   1. a\n   2. b\n2. c");
      expect(itemDepth(view, 3)).toBe(2);
      expect(itemDepth(view, 4)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  // (c) a NEW nested ordered run restarts at 1 and renumbers the vacated outer run.
  it("(c) Tab starting a new nested ordered run resets to 1 + renumbers vacated run", () => {
    const view = mount("1. A\n2. B\n3. C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 3) }); // caret in "2. B"
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. A\n   1. B\n2. C");
      expect(itemDepth(view, 2)).toBe(2);
      expect(itemDepth(view, 3)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  // (d) empty-item parent fallback: contentColumnOf falls back to markCol +
  //     markerLen + 1 for the empty "2. ", so the bullet nests to col 3.
  it("(d) nests under an EMPTY ordered parent at markCol + markerLen + 1", () => {
    const view = mount("2. \n- x", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 1) }); // caret in "- x"
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("2. \n   - x");
      expect(itemDepth(view, 2)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  // (codex) a `0.`-based run must never renumber a follower to a negative
  //     marker: indenting the middle of "0. A/0. B/0. C" drives the vacated-run
  //     delta to -1, so a naked (lower-bound-free) renumber would emit "-1. C"
  //     (which ORDERED_RE rejects = corrupt Markdown). orderedShape fails the
  //     whole renumber closed instead.
  it("(codex) indenting a 0.-based run never emits a negative marker", () => {
    const view = mount("0. A\n0. B\n0. C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 3) }); // caret in the middle "0. B"
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).not.toContain("-1.");
      // The vacated-run renumber fails closed (negative follower), so "0. C"
      // is left untouched — B still nests, but no corrupt marker is produced.
      expect(view.state.doc.toString()).not.toContain("-1");
    } finally {
      view.destroy();
    }
  });

  // (e) non-contiguous parent (Paragraph, List, Paragraph): the parent's tail is
  //     a Paragraph, not the earlier child list → a NEW nested run (does NOT
  //     continue the earlier child run's numbering).
  it("(e) non-contiguous parent (list then paragraph) starts a NEW nested run", () => {
    const view = mount("1. p\n\n   - a\n\n   tail\n2. b\n3. c", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 6, 3) }); // caret in "2. b"
    try {
      expect(indentListItem(view)).toBe(true);
      // "2. b" starts a NEW ordered run reset to 1 after "tail"; "3. c" → "2. c".
      expect(view.state.doc.toString()).toBe("1. p\n\n   - a\n\n   tail\n   1. b\n2. c");
      expect(itemDepth(view, 6)).toBe(2);
      expect(itemDepth(view, 7)).toBe(1);
    } finally {
      view.destroy();
    }
  });
});

describe("outdentListItem", () => {
  it("promotes a nested bullet to its parent's level — depth 2→1", () => {
    const view = mount("- A\n  - B", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 4) });
    try {
      expect(itemDepth(view, 2)).toBe(2);
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n- B");
      expect(itemDepth(view, 2)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("carries deeper children along on outdent", () => {
    const view = mount("- A\n  - B\n    - C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 4) });
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n- B\n  - C");
      expect(itemDepth(view, 2)).toBe(1);
      expect(itemDepth(view, 3)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("outdent adopts ordered marker + renumbers: nested bullet -> next number", () => {
    const view = mount("1. test\n2. test\n   - ddd\n3. ddd", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 3, 5) }); // caret in "   - ddd"
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. test\n2. test\n3. ddd\n4. ddd");
      expect(itemDepth(view, 3)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("is a no-op (returns true) on a top-level item — nothing to promote to", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n- B");
    } finally {
      view.destroy();
    }
  });

  // (a) delimiter preserved on adoption
  it("(a) adopts the parent's `)` delimiter, not `.`", () => {
    const view = mount("1) a\n   - b\n2) c", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 5) }); // caret in "   - b"
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1) a\n2) b\n3) c");
      expect(itemDepth(view, 2)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  // (b) empty-item task-ness adoption (user Case 1) under a task parent
  it("(b) empty item adopts the task parent's `[ ] `", () => {
    const view = mount("- [ ] aaa\n  - bbb\n  - ", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).to) }); // empty "  - "
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] aaa\n  - bbb\n- [ ] ");
      expect(itemDepth(view, 3)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  // (c) checked predecessor still yields an UNCHECKED continuation
  it("(c) empty item under a CHECKED task parent adopts `[ ] ` (unchecked)", () => {
    const view = mount("- [x] aaa\n  - ", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) });
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x] aaa\n- [ ] ");
    } finally {
      view.destroy();
    }
  });

  // (d) ordered-task empty adoption (needs a preceding sibling — parser note)
  it("(d) empty item adopts an ordered task parent's next-number + `[ ] `", () => {
    const view = mount("3. [x] aaa\n   - bbb\n   - ", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).to) }); // empty "   - "
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("3. [x] aaa\n   - bbb\n4. [ ] ");
    } finally {
      view.destroy();
    }
  });

  // (e) deliberate checkbox-drop: empty task under a PLAIN bullet
  it("(e) empty task under a plain bullet drops the checkbox", () => {
    const view = mount("- p\n  - [ ] ", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) }); // "  - [ ] "
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- p\n- ");
    } finally {
      view.destroy();
    }
  });

  // (f) non-empty task: checkbox bytes untouched (marker KIND only)
  it("(f) non-empty task preserves its checkbox on ordered adoption", () => {
    const view = mount("2. x\n   - [ ] t", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) }); // in "   - [ ] t"
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("2. x\n3. [ ] t");
      expect(itemDepth(view, 2)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  // (g) forced-children: the item's OLD following siblings become its children
  it("(g) forced children re-home under the promoted item; run renumbers", () => {
    const view = mount("1. p\n   - a\n   - b\n2. c", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 5) }); // caret in "   - a"
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. p\n2. a\n   - b\n3. c");
      expect(itemDepth(view, 2)).toBe(1); // a promoted to top level
      expect(itemDepth(view, 3)).toBe(2); // b now a's child
    } finally {
      view.destroy();
    }
  });

  // (h) multi-digit: promoted item's own nested children re-anchor to the
  //     +1-wide content column (`10.` marker is 3 bytes → content col 3 + 1).
  it("(h) multi-digit adoption re-indents the promoted item's own children", () => {
    // parent "9. p" → adopted "10." (parentNumber+1). The nested bullet has an
    // own child that must move from content col 2 to content col 4 (`10. ` = 4).
    const view = mount("9. p\n   - a\n     - kid\n10. q", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 5) }); // caret in "   - a"
    try {
      expect(outdentListItem(view)).toBe(true);
      // "- a" adopts "10." (col 0), its "     - kid" child re-anchors to col 4;
      // old "10. q" renumbers to "11. q".
      expect(view.state.doc.toString()).toBe("9. p\n10. a\n    - kid\n11. q");
    } finally {
      view.destroy();
    }
  });

  // (i) ordered forced-children crossing a digit-width boundary: each descendant
  //     line gets exactly ONE net whitespace change (no overlapping ChangeSpec).
  it("(i) ordered forced child renumber+re-indent folds into ONE net delta", () => {
    // "1. p" has nested ordered children "9." and "10." (a forced-child run that,
    // renumbered from 1, becomes "1." and "2." — widths 2→2 and 3→2). Outdent
    // "9." → it adopts "2." at top level; "10." re-homes as its child renumbered
    // to "1." (width 3→2) AND re-indented — one net change per line.
    const doc = "1. p\n   9. a\n   10. b\n2. c";
    const view = mount(doc, EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 6) }); // caret in "   9. a"
    try {
      expect(outdentListItem(view)).toBe(true);
      // "9. a" → "2. a" at top (col 0); "10. b" → child "1. b" at content col 3.
      expect(view.state.doc.toString()).toBe("1. p\n2. a\n   1. b\n3. c");
    } finally {
      view.destroy();
    }
  });

  // (j) combined adversarial: the moved item's OWN child + an ordered forced
  //     child + a destination width change all feed the net-delta map at once.
  it("(j) combined: own child + ordered forced child + destination renumber", () => {
    // parent "9. p" (adopted "10." — dest run "10. z" → "11. z", width 3→3).
    // moved item "1. a" has own child "      - kid"; ordered forced sibling
    // "9. b" renumbers to child "1. b" AND re-indents (+1 col). All three
    // whitespace sources hit distinct lines with ONE net change each, no overlap.
    const doc = "9. p\n   1. a\n      - kid\n   9. b\n10. z";
    const view = mount(doc, EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 6) }); // caret in "   1. a"
    try {
      expect(outdentListItem(view)).toBe(true);
      // "1. a" → "10. a" (col 0). own "- kid" → content col 4. forced "9. b" →
      // child "1. b" at content col 4. dest "10. z" → "11. z".
      expect(view.state.doc.toString()).toBe("9. p\n10. a\n    - kid\n    1. b\n11. z");
    } finally {
      view.destroy();
    }
  });

  // (k) caret placement after an empty-item outdent (ready to type)
  it("(k) empty-item outdent leaves the caret right after the synthesized marker", () => {
    const view = mount("- [ ] aaa\n  - bbb\n  - ", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).to) });
    try {
      expect(outdentListItem(view)).toBe(true);
      // doc is "- [ ] aaa\n  - bbb\n- [ ] "; caret sits at end (after "- [ ] ").
      expect(view.state.selection.main.head).toBe(view.state.doc.length);
    } finally {
      view.destroy();
    }
  });

  // (fable-1) empty-item outdent with TAB indent at EOF: the caret must be
  //     derived from CHARS removed, not the column count. With a surviving tab
  //     (1 char = tabSize columns) a column-based caret overshoots the
  //     shortened line -> view.dispatch throws RangeError -> applyShift swallows
  //     it -> the WHOLE outdent is silently lost. Chars-removed keeps it in range.
  it("(fable-1) empty item under TAB indent at EOF outdents without a RangeError", () => {
    const view = mount("- a\n\t- b\n\t\t- ", EditorSelection.cursor(0), { tabSize: 4 });
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).to) }); // empty "\t\t- "
    try {
      expect(outdentListItem(view)).toBe(true);
      // The outdent COMPOSED (not swallowed): the empty item promoted one level,
      // its tab collapsing to a single one under "- b".
      expect(view.state.doc.toString()).toBe("- a\n\t- b\n\t- ");
      // Caret stays within the (shortened) document — the bug parked it past EOF.
      expect(view.state.selection.main.head).toBeLessThanOrEqual(view.state.doc.length);
    } finally {
      view.destroy();
    }
  });

  // (fable-2) aligned-gap (gap 2) non-empty outdent: promotedContentCol must use
  //     the item's REAL marker->content gap, not a hard-coded 1. A forced child
  //     at the true content column would otherwise fail to nest and the outer
  //     run corrupts to 1,2,1,3.
  it("(fable-2) aligned-gap outdent nests the forced child; outer run stays intact", () => {
    const view = mount("1. p\n   1.  a\n   2. b\n2. q", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 7) }); // caret in "   1.  a" (gap 2)
    try {
      expect(outdentListItem(view)).toBe(true);
      // "1.  a" promotes to "2.  a" (gap 2 preserved -> content col 4); forced
      // "2. b" nests as its child "1. b" at col 4; dest "2. q" -> "3. q". Outer
      // run is 1,2,3 — NOT 1,2,1,3 (the hard-coded gap-1 bug parked the child at
      // col 3 < 4, so it stayed top-level and the run corrupted).
      expect(view.state.doc.toString()).toBe("1. p\n2.  a\n    1. b\n3. q");
      expect(itemDepth(view, 2)).toBe(1);
      expect(itemDepth(view, 3)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  // (test-analyzer-1) empty item WITH forced children: marker synthesis +
  //     re-homed forced children + destination renumber must compose without a
  //     disjointness throw, and the caret lands after the synthesized marker.
  it("(test-analyzer-1) empty item with forced children composes; caret after marker", () => {
    const view = mount("- p\n  - \n  - b\n  - c", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) }); // empty "  - "
    try {
      expect(outdentListItem(view)).toBe(true);
      // The empty item promotes to top level "- "; "b" and "c" become its
      // forced children at content col 2.
      expect(view.state.doc.toString()).toBe("- p\n- \n  - b\n  - c");
      expect(itemDepth(view, 2)).toBe(1);
      expect(itemDepth(view, 3)).toBe(2);
      // Caret right after the synthesized "- " on line 2.
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).to);
    } finally {
      view.destroy();
    }
  });

  // (test-analyzer-3) tab-indented nested item outdent: the documented
  //     whole-tab removal (leadingCharsForColumns counts a straddling tab
  //     whole) is exercised — a tab-indented child promotes by removing the
  //     whole tab, not a partial column count. Lands after fable-1's fix.
  it("(test-analyzer-3) tab-indented nested item outdents by whole-tab removal", () => {
    const view = mount("- A\n\t- B", EditorSelection.cursor(0), { tabSize: 4 });
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) }); // in "\t- B"
    try {
      expect(outdentListItem(view)).toBe(true);
      // "\t- B" promotes to top level "- B": the whole leading tab is removed.
      expect(view.state.doc.toString()).toBe("- A\n- B");
      expect(itemDepth(view, 2)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("returns true (swallow) in a plain paragraph", () => {
    const view = mount("paragraph", EditorSelection.cursor(3));
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("paragraph");
    } finally {
      view.destroy();
    }
  });
});

describe("listIndentKeymap — registration + precedence", () => {
  function mountWithKeymap(doc: string, selection: EditorSelection | SelectionRange): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      selection,
      extensions: [markdown({ base: markdownLanguage }), listIndentKeymap()],
    });
    return forceParse(new EditorView({ state, parent }));
  }

  it("Tab via runScopeHandlers nests the item (keymap wires Tab → indentListItem)", () => {
    const view = mountWithKeymap("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from + 2) });
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n  - B");
    } finally {
      view.destroy();
    }
  });

  it("Shift-Tab via runScopeHandlers outdents the item", () => {
    const view = mountWithKeymap("- A\n  - B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from + 4) });
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n- B");
    } finally {
      view.destroy();
    }
  });

  it("Tab in a plain paragraph is swallowed (handled=true, doc unchanged) — no focus escape", () => {
    const view = mountWithKeymap("plain text", EditorSelection.cursor(3));
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("plain text");
    } finally {
      view.destroy();
    }
  });

  it("exports exactly the two commands + the keymap factory", async () => {
    const mod = await import("../../../src/webview/cm/list/list-indent-keymap.js");
    expect(Object.keys(mod).sort()).toEqual(
      ["indentListItem", "listIndentKeymap", "outdentListItem"].sort()
    );
  });
});
