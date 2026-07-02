// Folding subtracts Blockquote + the inner Paragraph + code blocks (FencedCode /
// indented CodeBlock) from lang-markdown's broad Block folds (see
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

describe("fold ranges subtract Blockquote, Paragraph, and code blocks", () => {
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

  it("a GFM table line STILL folds", () => {
    expect(foldableAt("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |\n", 0)).not.toBeNull();
  });
});

// Defined-contract pins: the subtraction targets the Blockquote/Paragraph/code
// NODES, so a blockquote that WRAPS a STILL-foldable structure (list, table,
// heading) keeps the INNER fold — consistent with "keep lists/tables/headings
// foldable". A blockquote wrapping only a code block (subtracted) shows no
// chevron. Pinning current behaviour so a future change here is a deliberate,
// reviewed decision — not a silent drift.
describe("foldable content nested in a blockquote stays foldable (contract)", () => {
  it("a blockquote wrapping a nested list STILL yields a fold (inner ListItem)", () => {
    expect(foldableAt("> - a\n>   - b\n>   - c\n", 0)).not.toBeNull();
  });

  it("a blockquote wrapping a GFM table STILL yields a fold (inner Table)", () => {
    expect(foldableAt("> | a | b |\n> | - | - |\n> | 1 | 2 |\n", 0)).not.toBeNull();
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
