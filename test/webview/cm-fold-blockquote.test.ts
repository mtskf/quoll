// Folding subtracts Blockquote + the inner Paragraph + code blocks (FencedCode /
// indented CodeBlock) + GFM Table from lang-markdown's broad Block folds (see
// src/webview/cm/markdown.ts). State-only — no view mounted, so no happy-dom
// pragma. Uses quollMarkdownLanguage() — the SAME language object editor.ts
// mounts — so this pins the delivered contract, and also DETECTS a lang-markdown
// upgrade that re-enables a subtracted chevron (see plan Constraints).
import { codeFolding, ensureSyntaxTree, foldable } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";

const lang = quollMarkdownLanguage();

function foldableAt(doc: string, at: number): { from: number; to: number } | null {
  const state = EditorState.create({ doc, extensions: [lang, codeFolding()] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const line = state.doc.lineAt(at);
  return foldable(state, line.from, line.to);
}

describe("fold ranges subtract Blockquote, Paragraph, code blocks, and tables", () => {
  it("a blockquote line yields NO foldable range", () => {
    expect(foldableAt("> line1\n> line2\n> line3\n", 0)).toBeNull();
  });

  it("a standalone multi-line paragraph yields NO foldable range", () => {
    expect(foldableAt("para a\npara b\npara c\n", 0)).toBeNull();
  });

  it("a fenced code block yields NO foldable range (code blocks need no fold)", () => {
    expect(foldableAt("```js\nconst x = 1\nconst y = 2\n```\n", 0)).toBeNull();
  });

  it("an indented code block yields NO foldable range", () => {
    expect(foldableAt("    code line 1\n    code line 2\n    code line 3\n\ntext\n", 0)).toBeNull();
  });

  it("a heading line STILL folds", () => {
    expect(foldableAt("# A\nbody1\nbody2\n# B\n", 0)).not.toBeNull();
  });

  it("a nested-list parent line STILL folds", () => {
    expect(foldableAt("- a\n  - b\n  - c\n- d\n", 0)).not.toBeNull();
  });

  it("a list item with a multi-line paragraph STILL folds (ListItem range, not Paragraph)", () => {
    // Guard the Paragraph-suppression blast radius (Codex Conf-86): the item
    // body still folds via ListItem even though the inner Paragraph cannot.
    const doc = "- item line one\n  item line two\n  item line three\n- next\n";
    expect(foldableAt(doc, 0)).not.toBeNull();
  });

  it("a GFM table line yields NO foldable range (table blocks offer no chevron)", () => {
    expect(foldableAt("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n", 0)).toBeNull();
  });

  it("a list-nested table row yields NO foldable range, but its list item STILL folds", () => {
    // A table nested in a list item: subtracting Table removes the chevron from
    // the table's own rows, while the ListItem fold (the genuine list affordance,
    // anchored on the item's marker line) is untouched — so the only chevron sits
    // on the list line, never on a table row.
    const doc = "- intro:\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n";
    expect(foldableAt(doc, 0)).not.toBeNull(); // list item line — list fold intact
    expect(foldableAt(doc, doc.indexOf("| a | b |"))).toBeNull(); // table row — no chevron
  });
});

// A tight list item whose GFM table starts on the SAME physical line as the `-`
// marker (`- | a | b |\n  | - | - |\n  | 1 | 2 |`) is a special case: subtracting
// the Table node removes the chevron from the table's own rows, but the ancestor
// ListItem foldNodeProp still yields a fold anchored at the marker-line end — and
// tableBlockField line-snaps its block widget to blockFrom = lineAt(Table.from).from
// (the marker line start), so the widget SWALLOWS the `-` marker and the ListItem
// chevron visually lands on the table. The ListItem foldNodeProp override in
// cm/markdown.ts suppresses the fold ONLY for this shape — the item's first content
// child is a Table starting on the marker line — while every genuine list fold
// (table on continuation lines, plain multi-line body) is preserved.
describe("a list item with a table on its marker line is NOT foldable", () => {
  const tight = "- | a | b |\n  | - | - |\n  | 1 | 2 |\n\nafter\n";

  it("the marker line yields NO foldable range (widget swallows the marker)", () => {
    expect(foldableAt(tight, 0)).toBeNull();
  });

  it("an ordered-list variant is suppressed the same way", () => {
    expect(foldableAt("1. | a | b |\n   | - | - |\n   | 1 | 2 |\n\nafter\n", 0)).toBeNull();
  });

  it("a table on a CONTINUATION line still folds (marker line carries text)", () => {
    // Regression guard: the suppression is scoped to the marker line. A table
    // that starts below the marker keeps the genuine list fold on `- intro:`.
    const doc = "- intro:\n\n  | a | b |\n  | - | - |\n  | 1 | 2 |\n";
    expect(foldableAt(doc, 0)).not.toBeNull();
  });

  it("a plain multi-line list item still folds", () => {
    // Regression guard: non-table list bodies are untouched.
    const doc = "- item line one\n  item line two\n  item line three\n- next\n";
    expect(foldableAt(doc, 0)).not.toBeNull();
  });
});

// Defined-contract pins: the subtraction targets the Blockquote/Paragraph/code/
// Table NODES, so a blockquote that WRAPS a STILL-foldable structure (list,
// heading) keeps the INNER fold — consistent with "keep lists/headings
// foldable". A blockquote wrapping only a code block or only a table (both
// subtracted) shows no chevron. Pinning current behaviour so a future change here
// is a deliberate, reviewed decision — not a silent drift.
describe("foldable content nested in a blockquote stays foldable (contract)", () => {
  it("a blockquote wrapping a nested list STILL yields a fold (inner ListItem)", () => {
    expect(foldableAt("> - a\n>   - b\n>   - c\n", 0)).not.toBeNull();
  });

  it("a blockquote wrapping ONLY a GFM table yields NO fold (inner Table subtracted)", () => {
    expect(foldableAt("> | a | b |\n> | - | - |\n> | 1 | 2 |\n", 0)).toBeNull();
  });

  it("a blockquote wrapping an ATX heading STILL yields a fold (headerIndent foldService)", () => {
    // Heading folds come from the foldService, NOT foldNodeProp — pinning that
    // the foldNodeProp override leaves the foldService path untouched.
    expect(foldableAt("> # H\n> body\n> more\n", 0)).not.toBeNull();
  });

  it("a blockquote wrapping ONLY a fenced block yields NO fold (code subtracted too)", () => {
    expect(foldableAt("> ```js\n> const x = 1\n> ```\n", 0)).toBeNull();
  });
});
