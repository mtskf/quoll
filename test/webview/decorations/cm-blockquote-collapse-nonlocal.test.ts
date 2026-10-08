// @vitest-environment happy-dom
// test/webview/decorations/cm-blockquote-collapse-nonlocal.test.ts
//
// Pins the blockquote collapse field against edits that are neither in nor next to the quote
// yet change whether it is a collapsible TOP-LEVEL quote (a lazy-run split, a list indent
// promotion/demotion, a link reference definition forming/dissolving, an unclosed fence
// opened above). Every case asserts BOTH the concrete expected shape (so it cannot pass by
// both sides being empty) AND that the field equals a from-scratch build of the same text.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { buildCollapseState } from "../../../src/webview/cm/collapse/line-collapse-field.js";
import {
  blockquoteCollapseField,
  blockquoteCollapseSpec,
} from "../../../src/webview/cm/decorations/blockquote-collapse.js";
import { setBlockquoteCollapseEffect } from "../../../src/webview/cm/decorations/blockquote-collapse-state.js";
import { BlockquoteCollapseToggleWidget } from "../../../src/webview/cm/decorations/blockquote-collapse-widget.js";
import { settledState } from "../helpers/settled-state.js";

const language = (): Extension[] => [markdown({ base: markdownLanguage })];

function lines(n: number, make: (k: number) => string): string[] {
  return Array.from({ length: n }, (_, i) => make(i + 1));
}

function quote(n: number): string {
  return lines(n, (k) => `> line ${k}`).join("\n");
}

function stateWith(doc: string, caret = 0): EditorState {
  return settledState(
    EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [...language(), blockquoteCollapseField],
    })
  );
}

interface Bar {
  from: number;
  to: number;
  key: number;
  expanded: boolean;
  hiddenCount: number;
}

function bars(set: DecorationSet): Bar[] {
  const out: Bar[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const widget = (iter.value.spec as { widget?: unknown }).widget;
    if (!(widget instanceof BlockquoteCollapseToggleWidget)) {
      throw new Error("unexpected non-collapse decoration");
    }
    out.push({
      from: iter.from,
      to: iter.to,
      key: widget.key,
      expanded: widget.expanded,
      hiddenCount: widget.hiddenCount,
    });
    iter.next();
  }
  return out;
}

/** The field's bars on `state`; throws unless the tree covers the whole document (an
 *  incomplete tree would make every "no bar" assertion hold for the wrong reason). */
function fieldBars(state: EditorState): Bar[] {
  expect(syntaxTree(state).length).toBe(state.doc.length);
  return bars(state.field(blockquoteCollapseField).decorations);
}

/** Fail unless the field's bars equal a from-scratch build of the same text, threading the
 *  field's own sticky `expanded` set. Returns the bars for the shape assertion. */
function expectMatchesFresh(state: EditorState): Bar[] {
  const actual = fieldBars(state);
  const fresh = settledState(
    EditorState.create({
      doc: state.doc,
      selection: state.selection,
      extensions: language(),
    })
  );
  const expected = bars(
    buildCollapseState(blockquoteCollapseSpec, fresh, state.field(blockquoteCollapseField).expanded)
      .decorations
  );
  expect(actual).toEqual(expected);
  return actual;
}

function edit(state: EditorState, from: number, to: number, insert: string): EditorState {
  return state.update({ changes: { from, to, insert } }).state;
}

/** Replace the whole text of 1-based line `n` with `text`. */
function setLine(state: EditorState, n: number, text: string): EditorState {
  const line = state.doc.line(n);
  return edit(state, line.from, line.to, text);
}

// Blank separators: an unseparated "prose below" would lazy-continue the quote.
const proseAround = ["prose above", "", quote(14), "", "prose below"].join("\n");

describe("blockquoteCollapseField — non-local structure changes", () => {
  const lazyDoc = (): string =>
    ["> first", ...lines(15, (k) => `lazy ${k}`), ...lines(14, (k) => `> tail ${k}`)].join("\n");

  it("1a. a heading replacing a lazy line splits the quote and bars the distant tail", () => {
    const start = stateWith(lazyDoc());
    // One 30-line Blockquote, one bar over lines 11..30.
    const before = expectMatchesFresh(start);
    expect(before).toHaveLength(1);
    expect(before[0].key).toBe(start.doc.line(1).from);
    expect(before[0].hiddenCount).toBe(20);

    const next = setLine(start, 7, "# heading"); // lazy line 6
    const after = expectMatchesFresh(next);
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe(next.doc.line(17).from); // the `> tail 1` line
    expect(after[0].hiddenCount).toBe(4);
  });

  it("1b. blanking a lazy line has the same effect", () => {
    const next = setLine(stateWith(lazyDoc()), 7, "");
    const after = expectMatchesFresh(next);
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe(next.doc.line(17).from);
    expect(after[0].hiddenCount).toBe(4);
  });

  it("1c. inserting a blank line mid-run has the same effect", () => {
    const start = stateWith(lazyDoc());
    const next = edit(start, start.doc.line(7).to, start.doc.line(7).to, "\n");
    const after = expectMatchesFresh(next);
    expect(after).toHaveLength(1);
    expect(after[0].key).toBe(next.doc.line(18).from);
    expect(after[0].hiddenCount).toBe(4);
  });

  const listDoc = (indented: boolean): string =>
    ["- item", "", indented ? "  para" : "para", "", ...lines(12, (k) => `  > q ${k}`)].join("\n");

  it("2. dedenting the paragraph promotes a distant list-nested quote to top level, and back", () => {
    const start = stateWith(listDoc(true));
    expect(expectMatchesFresh(start)).toEqual([]);

    const dedented = setLine(start, 3, "para");
    const on = expectMatchesFresh(dedented);
    expect(on).toHaveLength(1);
    expect(on[0].hiddenCount).toBe(2);
    expect(on[0].key).toBe(dedented.doc.line(5).from);

    const back = setLine(dedented, 3, "  para");
    expect(expectMatchesFresh(back)).toEqual([]);
  });

  it("3. a link reference definition forming/dissolving moves a distant quote in and out of the list", () => {
    const doc = ["- item", "", "  [a]: /url", "lazy", "", ...lines(12, (k) => `  > q ${k}`)].join(
      "\n"
    );
    const start = stateWith(doc);
    const intact = expectMatchesFresh(start);
    expect(intact).toHaveLength(1);
    expect(intact[0].hiddenCount).toBe(2);

    const dissolved = edit(start, start.doc.line(3).from + 5, start.doc.line(3).from + 6, ";");
    expect(dissolved.doc.line(3).text).toBe("  [a]; /url");
    expect(expectMatchesFresh(dissolved)).toEqual([]);

    const restored = edit(
      dissolved,
      dissolved.doc.line(3).from + 5,
      dissolved.doc.line(3).from + 6,
      ":"
    );
    expect(restored.doc.line(3).text).toBe("  [a]: /url");
    const again = expectMatchesFresh(restored);
    expect(again).toHaveLength(1);
    expect(again[0].hiddenCount).toBe(2);
  });

  it("4. an unclosed fence opened above swallows the quote; closing it brings the bar back", () => {
    const doc = proseAround;
    const start = stateWith(doc);
    const initial = expectMatchesFresh(start);
    expect(initial).toHaveLength(1);
    expect(initial[0].hiddenCount).toBe(4);

    const fenced = edit(start, 0, 0, "```\n");
    expect(expectMatchesFresh(fenced)).toEqual([]);

    const closed = edit(fenced, fenced.doc.line(2).from, fenced.doc.line(2).from, "```\n");
    const reopened = expectMatchesFresh(closed);
    expect(reopened).toHaveLength(1);
    expect(reopened[0].hiddenCount).toBe(4);
  });

  it("5. ordinary edits keep an expanded quote expanded", () => {
    const doc = proseAround;
    let state = stateWith(doc);
    const key = state.doc.line(3).from;
    state = state.update({
      effects: setBlockquoteCollapseEffect.of({ key, expanded: true }),
    }).state;
    const open = expectMatchesFresh(state);
    expect(open).toHaveLength(1);
    expect(open[0].expanded).toBe(true);
    expect(open[0].hiddenCount).toBe(4);

    // Above the quote.
    state = edit(state, 0, 0, "x");
    let now = expectMatchesFresh(state);
    expect(now).toHaveLength(1);
    expect(now[0].expanded).toBe(true);
    expect(now[0].key).toBe(key + 1);

    // Inside a visible `>` line.
    const line4 = state.doc.line(4);
    state = edit(state, line4.to, line4.to, "!");
    now = expectMatchesFresh(state);
    expect(now[0].expanded).toBe(true);
    expect(now[0].hiddenCount).toBe(4);

    // Below the quote.
    state = edit(state, state.doc.length, state.doc.length, "!");
    now = expectMatchesFresh(state);
    expect(now[0].expanded).toBe(true);

    // Appending a line to the quote itself.
    const lastQuote = state.doc.line(16);
    state = edit(state, lastQuote.to, lastQuote.to, "\n> x");
    now = expectMatchesFresh(state);
    expect(now).toHaveLength(1);
    expect(now[0].expanded).toBe(true);
    expect(now[0].hiddenCount).toBe(5);
  });

  it("6. policy pin: a plain prose insertion plans a FULL rebuild (Decision 3)", () => {
    // Tripwire for swapping in a bounded policy. Plan Decision 3 lists three parser-verified
    // counterexamples where a distant edit changes whether a top-level Blockquote exists
    // (cases 1-3 above); every bounded predicate tried leaked one. Do not weaken this to
    // "returns something sound" — read Decision 3 first.
    const start = stateWith(["prose", quote(14)].join("\n"));
    const tr = start.update({ changes: { from: 0, to: 0, insert: "x" } });
    expect(blockquoteCollapseSpec.docChangePlan(tr, [])).toBe("full");
  });
});
