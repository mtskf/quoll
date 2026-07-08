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
  if (found === null) throw new Error(`no ListItem at line ${n}`);
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
