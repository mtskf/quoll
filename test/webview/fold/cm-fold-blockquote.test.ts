// Folding subtracts Blockquote + the inner Paragraph + code blocks (FencedCode /
// indented CodeBlock) + GFM Table from lang-markdown's broad Block folds (see
// src/webview/cm/markdown.ts). State-only — no view mounted, so no happy-dom
// pragma. Uses quollMarkdownLanguage() — the SAME language object editor.ts
// mounts — so this pins the delivered contract, and also DETECTS a lang-markdown
// upgrade that re-enables a subtracted chevron (see plan Constraints).
import { codeFolding, foldable, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import { settledState } from "../helpers/settled-state.js";

const lang = quollMarkdownLanguage();

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [lang, codeFolding()] });
}

// Query the fold over a SETTLED parse: `foldable()` resolves in the language field's
// tree snapshot, which a bare `ensureSyntaxTree` leaves truncated — see
// ../helpers/settled-state.ts. The truncation this closes is pinned deterministically
// by the "reads a settled parse" describe at the bottom of this file.
function foldableAt(doc: string, at: number): { from: number; to: number } | null {
  const state = settledState(stateFor(doc));
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

  it("a blockquote-nested table on the marker line yields NO fold (nothing folds in a blockquote)", () => {
    // A blockquote-nested table is a Table on the marker line too, and its
    // continuation lines carry `>` markers so parseTable rejects the slice and
    // tableBlockField emits NO widget — it renders as raw source. That used to
    // keep the list fold (the emit guard in listItemFold); the blockquote-ancestor
    // rule now wins first, so the visible `> - | a | b |` line shows no chevron.
    const doc = "> - | a | b |\n>   | - | - |\n>   | 1 | 2 |\n\nafter\n";
    expect(foldableAt(doc, doc.indexOf("- | a | b |"))).toBeNull();
  });

  it("an ordinary (indented) tight table still suppresses the fold (widget emitted)", () => {
    // Companion to the guard above: a 2-space-indented list-continuation table
    // DOES parse + emit a widget, so the marker-line suppression still fires.
    expect(foldableAt("- | a | b |\n  | - | - |\n  | 1 | 2 |\n\nafter\n", 0)).toBeNull();
  });

  it("a marker-line table inside leading frontmatter STILL folds (widget suppressed by fmEnd)", () => {
    // Codex Conf-74: Lezer parses the fence body as a ListItem with a marker-line
    // Table whose slice parses, but tableBlockField skips the widget because the
    // table sits inside leading frontmatter (m.from < fmEnd) — so the list fold on
    // the revealed raw source must be KEPT, the same lockstep the emit guard owns.
    const doc = "---\n- | a | b |\n  | - | - |\n  | 1 | 2 |\n---\n\nafter\n";
    expect(foldableAt(doc, doc.indexOf("- | a | b |"))).not.toBeNull();
  });
});

// Nothing folds inside a blockquote (callouts included — a callout IS a
// blockquote). Subtracting the Blockquote/Paragraph/code/Table NODES is not
// enough on its own: any other block nested in the quote owns its own fold — a
// ListItem, and every Block lang-markdown's broad foldNodeProp still folds
// (HTMLBlock, CommentBlock, LinkReference, ProcessingInstructionBlock), plus
// headings via the headerIndent foldService. So there is one Blockquote-ancestor
// gate per seam: one wrapping EVERY foldNodeProp fold, one in the heading
// foldService (see `insideBlockquote` in src/webview/cm/markdown.ts). The same
// structures at top level keep folding — pinned in the first describe above and
// by the controls at the end of this one.
describe("nothing nested in a blockquote is foldable", () => {
  it("a blockquote wrapping a nested list yields NO fold", () => {
    expect(foldableAt("> - a\n>   - b\n>   - c\n", 0)).toBeNull();
  });

  it("a blockquote wrapping ONLY a GFM table yields NO fold (inner Table subtracted)", () => {
    expect(foldableAt("> | a | b |\n> | - | - |\n> | 1 | 2 |\n", 0)).toBeNull();
  });

  it("a blockquote wrapping an ATX heading yields NO fold", () => {
    expect(foldableAt("> # H\n> body\n> more\n", 0)).toBeNull();
  });

  it("a blockquote wrapping a Setext heading yields NO fold", () => {
    expect(foldableAt("> H\n> ===\n> body\n> more\n", 0)).toBeNull();
  });

  it("a callout wrapping a heading or a list yields NO fold", () => {
    const heading = "> [!NOTE]\n> # H\n> body\n> more\n";
    expect(foldableAt(heading, heading.indexOf("# H"))).toBeNull();
    const list = "> [!NOTE]\n> - a\n>   - b\n>   - c\n";
    expect(foldableAt(list, list.indexOf("- a"))).toBeNull();
  });

  it("a heading in a list in a blockquote yields NO fold (ancestor, not just parent)", () => {
    const doc = "> - # H\n>   body\n>   more\n";
    expect(foldableAt(doc, 0)).toBeNull();
  });

  it("a list in a blockquote in a list yields NO fold on the quoted line", () => {
    // The outer item still folds from ITS marker line; the quoted inner item
    // does not, and the outer range cannot be claimed from the inner line.
    const doc = "- outer\n  > - a\n  >   - b\n  >   - c\n";
    expect(foldableAt(doc, 0)).not.toBeNull();
    expect(foldableAt(doc, doc.indexOf("- a"))).toBeNull();
  });

  it("a blockquote wrapping ONLY a fenced block yields NO fold (code subtracted too)", () => {
    expect(foldableAt("> ```js\n> const x = 1\n> ```\n", 0)).toBeNull();
  });

  // The Block types `nonFoldableBlocks` does NOT subtract by name: upstream's
  // broad Block fold still owns them, so only the blockquote gate wrapping every
  // foldNodeProp fold keeps them chevron-free inside a quote.
  it("a blockquote wrapping a multi-line HTML block yields NO fold", () => {
    expect(foldableAt("> <div>\n> x\n> </div>\n", 0)).toBeNull();
  });

  it("a callout wrapping a multi-line HTML comment yields NO fold", () => {
    const doc = "> [!NOTE]\n> <!-- a\n> b\n> -->\n";
    expect(foldableAt(doc, doc.indexOf("<!--"))).toBeNull();
  });

  it("a blockquote wrapping a multi-line link reference yields NO fold", () => {
    expect(foldableAt('> [foo]: /url\n> "title"\n', 0)).toBeNull();
  });

  it("a blockquote wrapping a multi-line processing instruction yields NO fold", () => {
    expect(foldableAt("> <?php\n> x\n> ?>\n", 0)).toBeNull();
  });

  it("a TOP-LEVEL multi-line HTML block STILL folds (the gate is blockquote-scoped)", () => {
    // Control: the gate is not a new global subtraction — outside a quote the
    // upstream Block fold passes through untouched.
    expect(foldableAt("<div>\nx\n</div>\n", 0)).toEqual({ from: 5, to: 14 });
  });

  it("a heading in a TOP-LEVEL list STILL folds (only a Blockquote ancestor suppresses)", () => {
    // The heading sits on a CONTINUATION line, so the ListItem fold (anchored on
    // the marker line) cannot reach it — this range comes from the heading
    // foldService alone, and goes null if the ancestor check ever widens to lists.
    const doc = "- intro\n\n  # H\n  body\n  more\n";
    expect(foldableAt(doc, doc.indexOf("# H"))).toEqual({ from: 14, to: 28 });
    // The marker-line shape folds too, but does not discriminate on its own: the
    // heading section and the ListItem yield the SAME range there.
    expect(foldableAt("- # H\n  body\n  more\n", 0)).not.toBeNull();
  });

  it("a top-level section that CONTAINS a blockquote heading still folds past it", () => {
    // The quoted `# Q` is not a section boundary for the top-level `# A`: it is
    // a child of the Blockquote, not a sibling, so `# A` folds to just before `# B`.
    const doc = "# A\nbody\n\n> # Q\n> quoted\n\ntail\n# B\n";
    expect(foldableAt(doc, 0)).toEqual({ from: 3, to: doc.indexOf("\n# B") });
  });
});

// The harness's own non-vacuity guard: proves `foldableAt` reads a SETTLED parse
// and not the possibly-truncated init snapshot. Deterministic by construction —
// no load required. `LanguageState.init` parses at most a 3000-char init viewport,
// so a doc longer than that ALWAYS lands a truncated snapshot in the field, which
// is exactly the state CPU preemption produced on the sub-KB fixtures above (the
// load-sensitive flake measured in PR #382's review cycle; docs/LEARNING.md
// 2026-07-23 + 2026-08-30). Drop the settle from `foldableAt` and the last
// assertion here goes red.
describe("the fold harness reads a settled parse, not a truncated snapshot", () => {
  // > 3000 chars of filler, then the fold target — so the target sits beyond the
  // init viewport that CM's snapshot covers.
  const PAD = "filler paragraph line\n\n".repeat(200);
  const doc = `${PAD}- a\n  - b\n  - c\n- d\n`;
  const at = doc.length - "- a\n  - b\n  - c\n- d\n".length;

  it("a freshly-created state's snapshot is truncated (the precondition)", () => {
    // Pins the CM behaviour this guard rests on: if an upstream change ever made
    // the init snapshot complete, this guard would be vacuous — so it goes red
    // instead of silently passing.
    const state = stateFor(doc);
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);
  });

  it("settling covers the whole doc", () => {
    const state = settledState(stateFor(doc));
    expect(syntaxTree(state).length).toBe(state.doc.length);
  });

  it("the truncated snapshot loses the fold that the settled one finds", () => {
    const raw = stateFor(doc);
    const rawLine = raw.doc.lineAt(at);
    expect(foldable(raw, rawLine.from, rawLine.to)).toBeNull(); // the flake's shape
    expect(foldableAt(doc, at)).not.toBeNull(); // ... which foldableAt no longer sees
  });
});
