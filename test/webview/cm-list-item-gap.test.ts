// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, forceParsing, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { describe, expect, it } from "vitest";
import { listItemGetsVerticalGap } from "../../src/webview/cm/list/list-geometry.js";

// NOTE: `forceParsing` (view-based) is used by Task 2/3 render helpers appended
// to this file; `ensureSyntaxTree` drives the state-only parse here.

function state(doc: string): EditorState {
  const st = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  // State-only parse: `forceParsing` needs an EditorView; `ensureSyntaxTree`
  // drives the parser off the state directly (small fixtures parse fully).
  ensureSyntaxTree(st, st.doc.length, 5_000);
  return st;
}

/** First ListItem whose marker line starts at (1-based) line `n`. */
function itemAtLine(st: EditorState, n: number): SyntaxNode {
  const from = st.doc.line(n).from;
  let found: SyntaxNode | null = null;
  syntaxTree(st).iterate({
    from,
    to: st.doc.line(n).to,
    enter: (node) => {
      if (found === null && node.name === "ListItem" && st.doc.lineAt(node.from).number === n) {
        found = node.node;
      }
    },
  });
  if (found === null) {
    throw new Error(`no ListItem at line ${n}`);
  }
  return found;
}

describe("listItemGetsVerticalGap", () => {
  it("first item of a tight bullet list keeps the gap", () => {
    const st = state("- a\n- b\n- c");
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 1))).toBe(true);
  });
  it("consecutive tight siblings drop the gap", () => {
    const st = state("- a\n- b\n- c");
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 2))).toBe(false);
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 3))).toBe(false);
  });
  it("loose items (blank line between) keep the gap", () => {
    const st = state("- a\n\n- b");
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 3))).toBe(true);
  });
  it("mixed tight/loose list is decided PER BOUNDARY (deliberate CommonMark divergence)", () => {
    const st = state("- a\n- b\n\n- c"); // one CommonMark loose list; we render a·b tight, c spaced
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 1))).toBe(true);
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 2))).toBe(false);
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 4))).toBe(true);
  });
  it("item after a multi-line tight item drops the gap", () => {
    const st = state("- a\n  cont\n- b");
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 3))).toBe(false);
  });
  it("first item after prose keeps the gap", () => {
    const st = state("para\n- a\n- b");
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 2))).toBe(true);
  });
  it("checkbox continuation: second task item drops the gap", () => {
    const st = state("- [ ] test\n- [ ] ddd");
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 2))).toBe(false);
  });
  it("INDENTED list (marker not at col 0): tight siblings still drop the gap", () => {
    const st = state("  - a\n  - b\n  - c");
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 1))).toBe(true);
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 2))).toBe(false);
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 3))).toBe(false);
  });
  it("BLOCKQUOTED list (marker at col 2): tight siblings still drop the gap", () => {
    const st = state("> - [ ] a\n> - [ ] b\n> - [ ] c");
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 2))).toBe(false);
    expect(listItemGetsVerticalGap(st, itemAtLine(st, 3))).toBe(false);
  });
});

import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { listHangIndent } from "../../src/webview/cm/list/list-hang-indent.js";
import { quollTheme } from "../../src/webview/cm/theme.js";

function render(doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
        listHangIndent,
        quollTheme,
      ],
    }),
    parent,
  });
  forceParsing(view as unknown as never, view.state.doc.length, 5_000);
  const lines = [...view.dom.querySelectorAll(".cm-line")].map((l) => ({
    text: l.textContent,
    hang: l.className.includes("quoll-list-hang"),
    hasIndentStyle: (l.getAttribute("style") ?? "").includes("padding-inline-start"),
  }));
  view.destroy();
  return lines;
}

describe("list-hang render — vertical gap gating", () => {
  it("tight siblings: only the first item carries quoll-list-hang; all keep the horizontal indent", () => {
    const lines = render("- a\n- b\n- c").filter((l) => l.text !== "");
    expect(lines.map((l) => l.hang)).toEqual([true, false, false]);
    expect(lines.every((l) => l.hasIndentStyle)).toBe(true); // horizontal hang preserved
  });
  it("checkbox Enter-continuation: second task item is tight (no gap class)", () => {
    const lines = render("- [ ] test\n- [ ] ddd").filter((l) => l.text !== "");
    expect(lines[1]?.hang).toBe(false);
  });
  it("loose list keeps the gap on the second item", () => {
    const lines = render("- a\n\n- b").filter((l) => l.text !== "");
    expect(lines[lines.length - 1]?.hang).toBe(true);
  });
});

import { quollFolding } from "../../src/webview/cm/fold/index.js";

function mountWithGutter(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
        listHangIndent,
        quollFolding(),
        quollTheme,
      ],
    }),
    parent,
  });
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

/** Booleans: does each list line carry the content gap-class, and does each
 *  gutter list-marker element carry the offset class. Blank lines are excluded
 *  on the content side (no list line) and absent on the gutter side. */
function contentVsGutter(view: EditorView) {
  const content = [...view.dom.querySelectorAll(".cm-content .cm-line")]
    .filter((l) => l.textContent !== "")
    .map((l) => l.className.includes("quoll-list-hang"));
  const gutter = [
    ...view.dom.querySelectorAll(".cm-foldGutter .cm-gutterElement.quoll-fold-list-marker"),
  ].map(() => true); // presence == has-offset; compare COUNT + positions below
  return { content, gutterCount: gutter.length };
}

describe("fold gutter lock-step", () => {
  it("tight list: gutter offset count matches content gap-class count", () => {
    const view = mountWithGutter("- a\n- b\n- c");
    const { content, gutterCount } = contentVsGutter(view);
    view.destroy();
    expect(content).toEqual([true, false, false]); // only the first item keeps the gap
    expect(gutterCount).toBe(content.filter(Boolean).length); // 1 offset marker, matching 1 gap line
  });

  it("bounded-recompute: deleting the blank line between a loose pair keeps content + gutter in lock-step", () => {
    const view = mountWithGutter("- a\n\n- b");
    // Sanity: initially loose — both items keep the gap on both sides.
    const before = contentVsGutter(view);
    expect(before.content).toEqual([true, true]);
    expect(before.gutterCount).toBe(2);

    // Delete the blank line (a NEWLINE-DELTA structural edit → full rebuild on
    // both sides). Doc is "- a\n\n- b": line 1 "- a" [0,3], line 2 "" [4,4],
    // line 3 "- b" [5,8]. Removing the blank line's newline collapses lines
    // 2+3 into one tight boundary.
    const blankLine = view.state.doc.line(2);
    view.dispatch({ changes: { from: blankLine.from, to: blankLine.to + 1, insert: "" } });
    forceParsing(view, view.state.doc.length, 5_000);

    const after = contentVsGutter(view);
    view.destroy();
    expect(after.content).toEqual([true, false]); // b is now a tight sibling of a
    expect(after.gutterCount).toBe(1); // gutter dropped b's offset in lock-step
  });

  it("table-delimiter completion outside the changed run's block re-shapes a FAR list boundary (TABLE-DELIM arm)", () => {
    // "- a" / "|h|" / "|--x|" (broken delimiter row, no Table forms — one
    // BulletList spans all 6 lines incl. "- b", tight) → completing the row to
    // "|---|" closes a Table, splitting the BulletList: "- b" becomes its OWN
    // top-level list, flipping its verdict from tight-sibling (no gap) to
    // first-item-after-prose (gap). This edit is confined to line 3 — OUTSIDE
    // "- b"'s own expandToEnclosingBlock window (a blank line separates them) —
    // so only the TABLE-DELIM arm's full-rebuild can keep the gutter in lock-step.
    const doc = "- a\n|h|\n|--x|\n\n  tail\n- b";
    const view = mountWithGutter(doc);
    const before = contentVsGutter(view);
    // Non-empty content lines: "- a", "|h|", "|--x|", "  tail", "- b". Only the
    // list-item MARKER lines ("- a", "- b") are candidates for the gap class;
    // "- b" is a tight sibling (still one BulletList, broken delimiter row) → no gap.
    expect(before.content).toEqual([true, false, false, false, false]);
    expect(before.gutterCount).toBe(1);

    // Complete the delimiter row: the "x" in "|--x|" (line 3) → "-".
    const editAt = doc.indexOf("x");
    view.dispatch({ changes: { from: editAt, to: editAt + 1, insert: "-" } });
    forceParsing(view, view.state.doc.length, 5_000);

    const after = contentVsGutter(view);
    view.destroy();
    // "- b" now heads its OWN top-level BulletList (the Table closed the first
    // one) → flips from tight-sibling to first-item-after-prose: gap = true.
    expect(after.content).toEqual([true, false, false, false, true]);
    expect(after.gutterCount).toBe(2); // gutter re-marks b in lock-step (was 1)
  });
});
