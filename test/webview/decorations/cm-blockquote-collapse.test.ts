// @vitest-environment happy-dom
// test/webview/decorations/cm-blockquote-collapse.test.ts
//
// Pins the blockquote "Show more" collapse (blockquote-collapse*.ts): geometry, the
// collapsed / expanded decoration shapes, sticky + auto expansion, the park-on-collapse
// contract, the top-level gate, reseed, and that the feature is VIEW-ONLY (no transaction
// it dispatches changes the document).
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldable, foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension, type Transaction } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { findCollapseBlockAt } from "../../../src/webview/cm/collapse/line-collapse-field.js";
import { blockStyle } from "../../../src/webview/cm/decorations/block-style.js";
import { blockquoteCollapseField } from "../../../src/webview/cm/decorations/blockquote-collapse.js";
import {
  blockquoteCollapseTarget,
  setBlockquoteCollapseEffect,
  toggleBlockquoteCollapse,
} from "../../../src/webview/cm/decorations/blockquote-collapse-state.js";
import { BlockquoteCollapseToggleWidget } from "../../../src/webview/cm/decorations/blockquote-collapse-widget.js";
import { CALLOUT_CLASS } from "../../../src/webview/cm/decorations/callout.js";
import { calloutMarkerConcealField } from "../../../src/webview/cm/decorations/callout-marker-conceal.js";
import { quollSyntaxReveal } from "../../../src/webview/cm/decorations/index.js";
import { fencedCodeCollapseField } from "../../../src/webview/cm/fenced-code/fenced-code-collapse.js";
import { FencedCollapseToggleWidget } from "../../../src/webview/cm/fenced-code/fenced-code-collapse-widget.js";
import { quollFolding } from "../../../src/webview/cm/fold/index.js";
import { leadingFrontmatterEnd } from "../../../src/webview/cm/frontmatter/detect.js";
import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";
import { blockStyleThemeSpec, collapseToggleThemeSpec } from "../../../src/webview/cm/theme.js";
import { settledState } from "../helpers/settled-state.js";
import { settledMount } from "../helpers/settled-view.js";
import { withUnstarvedFrontierState } from "../helpers/unstarved-frontier.js";

/** `n` lines `> line 1` … `> line n`. */
function quote(n: number): string {
  return Array.from({ length: n }, (_, i) => `> line ${i + 1}`).join("\n");
}

function lines(n: number, make: (k: number) => string): string {
  return Array.from({ length: n }, (_, i) => make(i + 1)).join("\n");
}

const baseExts = (): Extension[] => [
  markdown({ base: markdownLanguage }),
  EditorState.allowMultipleSelections.of(true),
  blockquoteCollapseField,
];

// Settled: the field's create() reads syntaxTree(state), and a freshly-created state can
// carry a truncated snapshot — every "no decoration" assertion would then hold for the
// wrong reason.
function stateWith(doc: string, caret = 0, extra: Extension[] = []): EditorState {
  return settledState(
    EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [...baseExts(), ...extra],
    })
  );
}

interface Deco {
  from: number;
  to: number;
  block: boolean;
  side: number | undefined;
  widget: BlockquoteCollapseToggleWidget | null;
}

function dump(set: DecorationSet): Deco[] {
  const out: Deco[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { block?: boolean; side?: number; widget?: unknown };
    out.push({
      from: iter.from,
      to: iter.to,
      block: spec.block === true,
      side: spec.side,
      widget: spec.widget instanceof BlockquoteCollapseToggleWidget ? spec.widget : null,
    });
    iter.next();
  }
  return out;
}

function decos(state: EditorState): Deco[] {
  return dump(state.field(blockquoteCollapseField).decorations);
}

function labelOf(widget: BlockquoteCollapseToggleWidget | null): string {
  if (widget === null) {
    throw new Error("decoration carries no BlockquoteCollapseToggleWidget");
  }
  return widget.toDOM({} as EditorView).textContent ?? "";
}

function mountWith(doc: string, caret = 0, extra: Extension[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return settledMount({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [...baseExts(), ...extra],
    }),
    parent,
  });
}

function toggleButton(view: EditorView): HTMLButtonElement | null {
  return view.dom.querySelector<HTMLButtonElement>(".quoll-blockquote-collapse-toggle");
}

function click(el: Element | null | undefined): void {
  el?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
}

describe("blockquoteCollapseField — shapes", () => {
  it("1. a 10-line quote has no collapse decoration", () => {
    expect(decos(stateWith(quote(10)))).toEqual([]);
  });

  it("2. an 11-line quote collapses its last line behind one block replace", () => {
    const state = stateWith(quote(11));
    const d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].block).toBe(true);
    expect(d[0].from).toBe(state.doc.line(11).from);
    expect(d[0].to).toBe(state.doc.line(11).to);
    expect(d[0].widget?.expanded).toBe(false);
    expect(d[0].widget?.hiddenCount).toBe(1);
    expect(labelOf(d[0].widget)).toBe("Show 1 more line");
  });

  it("3. an 18-line quote reports Show 8 more lines over lines 11..18", () => {
    const state = stateWith(quote(18));
    const d = decos(state);
    expect(d).toHaveLength(1);
    expect(labelOf(d[0].widget)).toBe("Show 8 more lines");
    expect(d[0].from).toBe(state.doc.line(11).from);
    expect(d[0].to).toBe(state.doc.line(18).to);
  });

  it("4. the effect expands to a side:1 point widget and collapses back", () => {
    let state = stateWith(quote(18));
    const collapsed = decos(state);
    state = state.update({
      effects: setBlockquoteCollapseEffect.of({ key: 0, expanded: true }),
    }).state;
    const d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].from).toBe(state.doc.line(18).to);
    expect(d[0].to).toBe(state.doc.line(18).to);
    expect(d[0].side).toBe(1);
    expect(d[0].block).toBe(true);
    expect(d[0].widget?.expanded).toBe(true);
    expect(labelOf(d[0].widget)).toBe("Show less");
    state = state.update({
      effects: setBlockquoteCollapseEffect.of({ key: 0, expanded: false }),
    }).state;
    const back = decos(state);
    expect(back).toHaveLength(1);
    expect(back[0].from).toBe(collapsed[0].from);
    expect(back[0].to).toBe(collapsed[0].to);
    expect(back[0].widget?.expanded).toBe(false);
    expect(back[0].widget?.hiddenCount).toBe(8);
  });
});

describe("blockquoteCollapseField — view-only", () => {
  it("5. clicking Show more / Show less never changes the document bytes", () => {
    const doc = quote(18);
    const txs: Transaction[] = [];
    const probe = EditorView.updateListener.of((u) => {
      txs.push(...u.transactions);
    });
    const v = mountWith(doc, 0, [probe]);
    try {
      txs.length = 0;
      const widgetStates: boolean[] = [];
      const expandedNow = (): boolean => toggleButton(v)?.getAttribute("aria-expanded") === "true";
      widgetStates.push(expandedNow());
      click(toggleButton(v)); // Show more
      expect(v.state.doc.toString()).toBe(doc);
      widgetStates.push(expandedNow());
      click(toggleButton(v)); // Show less
      expect(v.state.doc.toString()).toBe(doc);
      widgetStates.push(expandedNow());
      // Non-vacuity: the transactions were observed and the widget really flipped twice.
      expect(txs.length).toBeGreaterThan(0);
      expect(widgetStates).toEqual([false, true, false]);
      expect(txs.some((tr) => tr.docChanged)).toBe(false);
    } finally {
      v.destroy();
    }
  });
});

describe("blockquoteCollapseField — what counts", () => {
  it("6. a nested quote counts toward the outer panel and never gets its own bar", () => {
    const doc = `${lines(6, (k) => `> a${k}`)}\n${lines(4, (k) => `> > inner${k}`)}\n${lines(4, (k) => `> b${k}`)}`;
    const state = stateWith(doc);
    const d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].widget?.hiddenCount).toBe(4);
    expect(d[0].from).toBe(state.doc.line(11).from);

    const nested = `${lines(4, (k) => `> o${k}`)}\n${lines(12, (k) => `> > i${k}`)}`;
    expect(decos(stateWith(nested))).toHaveLength(1);
  });

  it("7. lazy continuation lines count", () => {
    const doc = `> first\n${lines(11, (k) => `lazy ${k}`)}`;
    const d = decos(stateWith(doc));
    expect(d).toHaveLength(1);
    expect(d[0].widget?.hiddenCount).toBe(2);
  });

  it("8. a callout counts its marker row and carries callout classes on the bar", () => {
    const doc = `> [!note]\n${lines(12, (k) => `> body ${k}`)}`;
    const state = stateWith(doc);
    const d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].widget?.hiddenCount).toBe(3);
    const root = d[0].widget?.toDOM({} as EditorView);
    expect(root?.classList.contains(CALLOUT_CLASS)).toBe(true);
    expect(root?.classList.contains("quoll-callout-note")).toBe(true);

    const plain = decos(stateWith(quote(12)))[0].widget?.toDOM({} as EditorView);
    expect(plain?.classList.contains(CALLOUT_CLASS)).toBe(false);
    expect(plain?.classList.contains("quoll-callout-note")).toBe(false);
  });
});

describe("blockquoteCollapseField — selection", () => {
  it("9. a head inside the concealed range auto-expands, and it is sticky", () => {
    let state = stateWith(quote(18));
    state = state.update({ selection: { anchor: state.doc.line(15).from } }).state;
    let d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].widget?.expanded).toBe(true);
    expect(d[0].from).toBe(d[0].to);
    state = state.update({ selection: { anchor: 0 } }).state;
    d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].widget?.expanded).toBe(true);
  });

  it("10. a caret elsewhere, or a select-all ending after the quote, stays collapsed", () => {
    const doc = `${quote(18)}\n\ntail`;
    let state = stateWith(doc, doc.length);
    expect(decos(state)[0].widget?.expanded).toBe(false);
    state = state.update({ selection: { anchor: 0, head: state.doc.length } }).state;
    const d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].widget?.expanded).toBe(false);
  });

  it("11. collapsing parks every head inside the concealed range, secondary ones included", () => {
    const view = mountWith(quote(18));
    try {
      toggleBlockquoteCollapse(view, 0, true);
      expect(decos(view.state)[0].widget?.expanded).toBe(true);
      const doc = view.state.doc;
      view.dispatch({
        selection: EditorSelection.create(
          [
            EditorSelection.cursor(doc.line(14).from + 2),
            EditorSelection.cursor(doc.line(2).from + 2),
          ],
          0
        ),
      });
      toggleBlockquoteCollapse(view, 0, false);
      const d = decos(view.state);
      expect(d).toHaveLength(1);
      expect(d[0].widget?.expanded).toBe(false);
      const heads = view.state.selection.ranges.map((r) => r.head).sort((a, b) => a - b);
      expect(heads).toEqual([doc.line(2).from + 2, doc.line(10).to].sort((a, b) => a - b));
      for (const r of view.state.selection.ranges) {
        expect(r.empty).toBe(true);
      }
      // Stays collapsed after one more (empty) dispatch — no bounce back open.
      view.dispatch({});
      expect(decos(view.state)[0].widget?.expanded).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("12. typing an 11th line at the end of a 10-line quote auto-expands rather than hiding the caret", () => {
    withUnstarvedFrontierState({
      what: "the expanded shape after growing a 10-line quote to 11 lines",
      observe: (requireUnstarvedFrontier) => {
        let state = stateWith(quote(10), quote(10).length);
        expect(decos(state)).toEqual([]);
        const insert = "\n> line 11";
        state = state.update({
          changes: { from: state.doc.length, insert },
          selection: { anchor: state.doc.length + insert.length },
        }).state;
        requireUnstarvedFrontier(state);
        const d = decos(state);
        expect(d).toHaveLength(1);
        expect(d[0].widget?.expanded).toBe(true);
        expect(d[0].from).toBe(d[0].to);
        return state;
      },
    });
  });
});

describe("blockquoteCollapseField — scope gate", () => {
  it("13. a quote inside a list item is not collapsible", () => {
    const doc = `- item\n\n${lines(12, (k) => `  > q ${k}`)}`;
    expect(decos(stateWith(doc))).toEqual([]);
  });

  it("14. an indented top-level quote is collapsible and keyed by its line start", () => {
    const state = stateWith(lines(12, (k) => `  > line ${k}`));
    const d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].widget?.key).toBe(0);
    expect(findCollapseBlockAt(blockquoteCollapseTarget, state, 0)).not.toBeNull();
  });

  it("14b. a quote-shaped run inside the leading frontmatter is never collapsible", () => {
    // A YAML block scalar whose lines look like a quote: Lezer parses them as a top-level
    // Blockquote, but the frontmatter block owns [0, fmEnd].
    const frontmatter = `---\ntitle: x\ndescription: |\n${lines(14, (k) => `  > metadata ${k}`)}\n---\n\n`;

    const only = stateWith(`${frontmatter}prose\n`);
    expect(leadingFrontmatterEnd(only)).toBeGreaterThan(0);
    expect(only.field(blockquoteCollapseField).decorations.size).toBe(0);
    expect(only.field(blockquoteCollapseField).blocks).toEqual([]);
    const fmQuoteKey = only.doc.line(4).from;
    expect(findCollapseBlockAt(blockquoteCollapseTarget, only, fmQuoteKey)).toBeNull();

    // A quote OUTSIDE the frontmatter of the same document still collapses.
    const state = stateWith(`${frontmatter}${quote(14)}`);
    const fmEnd = leadingFrontmatterEnd(state);
    expect(fmEnd).toBeGreaterThan(0);
    const field = state.field(blockquoteCollapseField);
    expect(field.blocks).toHaveLength(1);
    expect(field.blocks[0].key).toBe(frontmatter.length);
    expect(field.blocks[0].hiddenCount).toBe(4);
    const d = decos(state);
    expect(d).toHaveLength(1);
    expect(d[0].from).toBeGreaterThan(fmEnd);
    expect(d[0].widget?.expanded).toBe(false);
  });
});

describe("blockquoteCollapseField — reseed, isolation, stale keys", () => {
  it("15. a host reseed resets the expansion", () => {
    withUnstarvedFrontierState({
      what: "the reseed branch's reset of the expanded set",
      observe: (requireUnstarvedFrontier) => {
        let state = stateWith(quote(18));
        state = state.update({
          effects: setBlockquoteCollapseEffect.of({ key: 0, expanded: true }),
        }).state;
        expect(decos(state)[0].widget?.expanded).toBe(true);
        // The replacement keeps the quote at key 0 so the stale key survives the position
        // mapping — that is what makes the reset observable.
        state = state.update({
          changes: { from: 0, to: state.doc.length, insert: quote(18) },
          annotations: hostDocumentReseed.of(true),
        }).state;
        requireUnstarvedFrontier(state);
        const d = decos(state);
        expect(d).toHaveLength(1);
        expect(d[0].widget?.expanded).toBe(false);
        return state;
      },
    });
  });

  it("16. a quote and a fenced block each own exactly their one decoration", () => {
    const fenced = `\`\`\`js\n${lines(12, (k) => `code ${k}`)}\n\`\`\``;
    const doc = `${quote(12)}\n\n${fenced}`;
    let state = stateWith(doc, 0, [fencedCodeCollapseField]);
    const bq = decos(state);
    expect(bq).toHaveLength(1);
    expect(bq[0].widget).not.toBeNull();
    const fencedField = state.field(fencedCodeCollapseField);
    const fd = dump(fencedField.decorations);
    expect(fd).toHaveLength(1);
    // Positively the fenced field's own decoration: a block replace starting at the fence's
    // 11th body line (fence open line + 10 body lines), widget a FencedCollapseToggleWidget.
    const fenceStart = doc.indexOf("```js");
    const eleventhBodyLine = state.doc.lineAt(fenceStart).number + 11;
    expect(fd[0].block).toBe(true);
    expect(fd[0].from).toBe(state.doc.line(eleventhBodyLine).from);
    expect(fd[0].widget).toBeNull(); // not a blockquote widget
    expect(fd[0].from).toBeGreaterThan(bq[0].to);
    const fencedSpec = fencedField.decorations.iter().value?.spec as { widget?: unknown };
    expect(fencedSpec.widget).toBeInstanceOf(FencedCollapseToggleWidget);

    state = state.update({
      effects: setBlockquoteCollapseEffect.of({ key: 0, expanded: true }),
    }).state;
    expect(decos(state)[0].widget?.expanded).toBe(true);
    expect(state.field(fencedCodeCollapseField)).toBe(fencedField);
  });

  it("17. a stale key is a harmless no-op in both directions", () => {
    const view = mountWith(quote(18));
    try {
      const before = decos(view.state).map((d) => [d.from, d.to, d.side, d.widget?.expanded]);
      expect(() => toggleBlockquoteCollapse(view, 9999, false)).not.toThrow();
      expect(() => toggleBlockquoteCollapse(view, 9999, true)).not.toThrow();
      const after = decos(view.state).map((d) => [d.from, d.to, d.side, d.widget?.expanded]);
      expect(after).toEqual(before);
    } finally {
      view.destroy();
    }
  });
});

describe("blockquoteCollapseField — combined registration", () => {
  it("18. coexists with the callout marker conceal, block-style and the reveal stack", () => {
    const callout = `> [!note]\n${lines(12, (k) => (k === 1 ? "> zeta-first-body" : `> body ${k}`))}`;
    const doc = `${callout}\n\ntail`;
    const view = mountWith(doc, doc.length, [
      calloutMarkerConcealField,
      blockStyle,
      quollSyntaxReveal(),
    ]);
    // The view is not wedged: the quote's first body line (a token no other line carries)
    // is still rendered.
    const firstLineRendered = (): boolean =>
      (view.dom.querySelector(".cm-content")?.textContent ?? "").includes("zeta-first-body");
    try {
      const d0 = view.state.doc;
      // Caret outside: the conceal field holds its marker-row decorations (inline replace
      // + line decoration on line 1, NOT a block replace); the collapse field holds one
      // block replace over lines 11-13; the two ranges are disjoint.
      const conceal = dump(view.state.field(calloutMarkerConcealField).decorations);
      expect(conceal.length).toBeGreaterThanOrEqual(2);
      expect(conceal.some((c) => c.from === d0.line(1).from && c.to === d0.line(1).to)).toBe(true);
      expect(conceal.some((c) => c.from === d0.line(1).from && c.to === d0.line(1).from)).toBe(
        true
      );
      expect(conceal.every((c) => !c.block)).toBe(true);
      const collapse = decos(view.state);
      expect(collapse).toHaveLength(1);
      expect(collapse[0].block).toBe(true);
      expect(collapse[0].from).toBe(d0.line(11).from);
      expect(collapse[0].to).toBe(d0.line(13).to);
      expect(conceal.every((c) => c.to < collapse[0].from)).toBe(true);
      expect(firstLineRendered()).toBe(true);

      // Caret into line 2: the marker row reveals, the quote stays collapsed.
      view.dispatch({ selection: { anchor: d0.line(2).from + 2 } });
      expect(view.state.field(calloutMarkerConcealField).decorations.size).toBe(0);
      expect(decos(view.state)[0].widget?.expanded).toBe(false);
      expect(firstLineRendered()).toBe(true);

      // The bar expands, then collapses again.
      click(toggleButton(view));
      expect(decos(view.state)[0].widget?.expanded).toBe(true);
      expect(firstLineRendered()).toBe(true);
      click(toggleButton(view));
      expect(decos(view.state)[0].widget?.expanded).toBe(false);
      expect(firstLineRendered()).toBe(true);
    } finally {
      view.destroy();
    }
  });
});

describe("blockquoteCollapseField — outer fold", () => {
  const QUOTE_BAR = ".quoll-blockquote-collapse-bar";

  function foldMount(doc: string, caret = 0): { view: EditorView; txs: Transaction[] } {
    const txs: Transaction[] = [];
    const view = mountWith(doc, caret, [
      quollFolding(),
      EditorView.updateListener.of((u) => {
        txs.push(...u.transactions);
      }),
    ]);
    return { view, txs };
  }

  /** The heading's fold range, asked of the repo's own foldService (not hand-spelled). */
  function headingRange(view: EditorView): { from: number; to: number } {
    const line = view.state.doc.line(1);
    const r = foldable(view.state, line.from, line.to);
    if (r === null) {
      throw new Error("heading does not fold");
    }
    return r;
  }

  const fold = (view: EditorView, r: { from: number; to: number }): void =>
    view.dispatch({ effects: foldEffect.of(r) });
  const unfold = (view: EditorView, r: { from: number; to: number }): void =>
    view.dispatch({ effects: unfoldEffect.of(r) });
  const expand = (view: EditorView, key: number): void =>
    view.dispatch({ effects: setBlockquoteCollapseEffect.of({ key, expanded: true }) });
  const barLabel = (view: EditorView): string | null =>
    view.dom.querySelector(`${QUOTE_BAR} .quoll-blockquote-collapse-label`)?.textContent ?? null;
  const fieldState = (view: EditorView) => view.state.field(blockquoteCollapseField);
  const allText = (view: EditorView): string => view.dom.textContent ?? "";

  function expectExpandedAndUncovered(view: EditorView): void {
    const d = decos(view.state);
    expect(d).toHaveLength(1);
    expect(d[0].widget?.expanded).toBe(true);
    const head = view.state.selection.main.head;
    for (const x of d) {
      expect(x.from < x.to && head >= x.from && head <= x.to).toBe(false);
    }
  }

  const collapsedDoc = `# H\n\n${quote(18)}`;

  it("1. a heading fold over a quote that ends the document hides the Show-less bar; unfold brings it back", () => {
    const { view } = foldMount(`# H\n\n${quote(14)}`);
    try {
      const key = view.state.doc.line(3).from;
      expand(view, key);
      expect(allText(view)).toContain("Show less");
      const r = headingRange(view);
      fold(view, r);
      expect(view.dom.querySelector(QUOTE_BAR)).toBeNull();
      expect(fieldState(view).decorations.size).toBe(0);
      expect(fieldState(view).expanded.has(key)).toBe(true);
      unfold(view, r);
      expect(barLabel(view)).toBe("Show less");
    } finally {
      view.destroy();
    }
  });

  it("2. same when the quote is the last block before the next heading", () => {
    const { view } = foldMount(`# H\n\n${quote(14)}\n\n# Next\n\ntail`);
    try {
      const key = view.state.doc.line(3).from;
      expand(view, key);
      const r = headingRange(view);
      fold(view, r);
      expect(view.dom.querySelector(QUOTE_BAR)).toBeNull();
      expect(fieldState(view).decorations.size).toBe(0);
      expect(fieldState(view).expanded.has(key)).toBe(true);
      unfold(view, r);
      expect(barLabel(view)).toBe("Show less");
    } finally {
      view.destroy();
    }
  });

  it("3. a collapsed quote under the fold shows no bar while folded and gets it back on unfold", () => {
    const { view } = foldMount(collapsedDoc);
    try {
      expect(barLabel(view)).toBe("Show 8 more lines");
      const r = headingRange(view);
      fold(view, r);
      expect(view.dom.querySelector(QUOTE_BAR)).toBeNull();
      expect(fieldState(view).decorations.size).toBe(0);
      unfold(view, r);
      expect(barLabel(view)).toBe("Show 8 more lines");
    } finally {
      view.destroy();
    }
  });

  it("4. a fold in a section that does not contain the quote leaves its decoration in place", () => {
    const { view } = foldMount(`# A\n\nbody\n\n# H\n\n${quote(18)}`);
    try {
      const before = decos(view.state);
      expect(before).toHaveLength(1);
      const line = view.state.doc.line(1);
      const r = foldable(view.state, line.from, line.to);
      if (r === null) {
        throw new Error("section A does not fold");
      }
      expect(r.to).toBeLessThan(before[0].from);
      fold(view, r);
      const after = decos(view.state);
      expect(after).toHaveLength(1);
      expect(after[0].from).toBe(before[0].from);
      expect(after[0].to).toBe(before[0].to);
      // Fold-set changes rebuild fully (new widget instances), so compare by value.
      expect(after[0].widget?.key).toBe(before[0].widget?.key);
      expect(after[0].widget?.expanded).toBe(before[0].widget?.expanded);
      expect(after[0].widget?.hiddenCount).toBe(before[0].widget?.hiddenCount);
    } finally {
      view.destroy();
    }
  });

  it("5. a jump into a folded, collapsed quote unfolds AND expands it (never a replace over the caret)", () => {
    const { view } = foldMount(collapsedDoc);
    try {
      fold(view, headingRange(view));
      expect(foldedRanges(view.state).size).toBe(1);
      view.dispatch({ selection: { anchor: view.state.doc.line(3 + 14).from } });
      expect(foldedRanges(view.state).size).toBe(0);
      expectExpandedAndUncovered(view);
      expect(barLabel(view)).toBe("Show less");
    } finally {
      view.destroy();
    }
  });

  it("6. unfold + a selection move into the quote in ONE transaction gives the expanded shape", () => {
    const { view } = foldMount(collapsedDoc);
    try {
      const r = headingRange(view);
      fold(view, r);
      view.dispatch({
        effects: unfoldEffect.of(r),
        selection: { anchor: view.state.doc.line(3 + 14).from },
      });
      expect(foldedRanges(view.state).size).toBe(0);
      expectExpandedAndUncovered(view);
      expect(barLabel(view)).toBe("Show less");
    } finally {
      view.destroy();
    }
  });

  it("6b. a secondary head in the concealed range expands the record while the fold survives (records, not decorations, decide)", () => {
    const { view } = foldMount(collapsedDoc);
    try {
      const r = headingRange(view);
      fold(view, r);
      expect(foldedRanges(view.state).size).toBe(1);
      const key = view.state.doc.line(3).from;
      expect(fieldState(view).blocks[0].expanded).toBe(false);
      // MAIN stays on the heading line (outside the fold), a SECONDARY head lands on a
      // concealed line: CodeMirror clears a fold only for the main head, so the fold
      // survives and ONLY the record-based selection check can notice the secondary head.
      view.dispatch({
        selection: EditorSelection.create(
          [
            EditorSelection.cursor(view.state.doc.line(1).from),
            EditorSelection.cursor(view.state.doc.line(3 + 14).from),
          ],
          0
        ),
      });
      expect(foldedRanges(view.state).size).toBe(1);
      const rec = fieldState(view).blocks.find((b) => b.key === key);
      expect(rec?.expanded).toBe(true);
      expect(fieldState(view).expanded.has(key)).toBe(true);
      unfold(view, r);
      expect(barLabel(view)).toBe("Show less");
    } finally {
      view.destroy();
    }
  });

  it("7. none of the fold / unfold / jump transactions changes the document", () => {
    const a = foldMount(`# H\n\n${quote(14)}`);
    const b = foldMount(collapsedDoc);
    try {
      const key = a.view.state.doc.line(3).from;
      expand(a.view, key);
      const ra = headingRange(a.view);
      fold(a.view, ra);
      unfold(a.view, ra);

      const rb = headingRange(b.view);
      fold(b.view, rb);
      b.view.dispatch({ selection: { anchor: b.view.state.doc.line(3 + 14).from } });
      fold(b.view, headingRange(b.view));
      b.view.dispatch({
        effects: unfoldEffect.of(headingRange(b.view)),
        selection: { anchor: b.view.state.doc.line(3 + 15).from },
      });

      const all = [...a.txs, ...b.txs];
      expect(all.length).toBeGreaterThan(0);
      expect(all.every((tr) => !tr.docChanged)).toBe(true);
    } finally {
      a.view.destroy();
      b.view.destroy();
    }
  });
});

describe("theme contract", () => {
  // The spec is read as a plain string-keyed record: these selectors are the contract.
  const spec = collapseToggleThemeSpec as unknown as Record<string, Record<string, string>>;
  const blockSpec = blockStyleThemeSpec as unknown as Record<string, Record<string, string>>;
  const BQ = ".quoll-blockquote-collapse-bar";
  const FC = ".quoll-fenced-collapse-bar";

  it("1. the bar is the fenced bar plus the divider's top padding", () => {
    const { paddingTop, ...rest } = spec[BQ] as Record<string, string>;
    expect(paddingTop).toBeDefined();
    expect(rest).toEqual(spec[FC]);
  });

  it("2. the collapsed bar shares the fenced collapsed footer", () => {
    expect(spec[`${BQ}-collapsed`]).toEqual(spec[`${FC}-collapsed`]);
  });

  it("3. the expanded bar is always the footer", () => {
    expect(spec[`${BQ}:not(${BQ}-collapsed)`]).toEqual(spec[`${FC}-collapsed`]);
  });

  it("4. one shared toggle object, link-coloured at full opacity", () => {
    const toggle = spec[".quoll-blockquote-collapse-toggle"];
    expect(toggle).toEqual(spec[".quoll-fenced-collapse-toggle"]);
    expect(toggle?.color).toContain("--vscode-textLink-foreground");
    expect(toggle?.opacity).toBe("1");
  });

  it("5. divider is a margin-free ::before on the blockquote bar only", () => {
    const before = spec[`${BQ}::before`];
    expect(before).toBeDefined();
    expect(before?.content).toBe('""');
    expect(before?.display).toBe("block");
    expect(before?.borderTop).toMatch(/^1px solid /);
    expect(before?.borderTop).toContain("--vscode-foreground");
    expect(before).not.toHaveProperty("marginTop");
    expect(spec[`${FC}::before`]).toBeUndefined();
  });

  it("6. the quote row above an expanded bar is un-rounded and un-gapped", () => {
    const key = Object.keys(spec).find(
      (k) =>
        k.includes(".cm-line.quoll-blockquote-close") &&
        k.includes(":has(+ .quoll-blockquote-collapse-bar")
    );
    expect(key).toBeDefined();
    const rule = spec[key as string];
    expect(rule?.borderBottomLeftRadius).toBe("0");
    expect(rule?.borderBottomRightRadius).toBe("0");
    expect(rule?.paddingBottom).toBe("0");
    expect(rule?.borderBottom).toBe("0");
  });

  it("6b. the row above a hidden nested-fence row before an expanded bar is un-rounded too", () => {
    const key = Object.keys(spec).find((k) =>
      k.includes(
        ".cm-line.quoll-blockquote-close:has(+ .cm-line.quoll-fenced-code-fence-hidden + .quoll-blockquote-collapse-bar"
      )
    );
    expect(key).toBeDefined();
    const rule = spec[key as string];
    expect(rule?.borderBottomLeftRadius).toBe("0");
    expect(rule?.borderBottomRightRadius).toBe("0");
    expect(rule?.paddingBottom).toBe("0");
    expect(rule?.borderBottom).toBe("0");
  });

  it("7. the bar carries the callout accent, generated from the rows' values", () => {
    const barShadow = spec[`${BQ}.quoll-callout`]?.boxShadow;
    const rowShadow = blockSpec[".cm-line.quoll-callout"]?.boxShadow;
    expect(barShadow).toBeDefined();
    expect(rowShadow).toBeDefined();
    expect(barShadow).toBe(rowShadow);
    for (const t of ["note", "tip", "important", "warning", "caution"]) {
      const bar = spec[`${BQ}.quoll-callout-${t}`]?.["--quoll-callout-accent"];
      expect(bar).toBeDefined();
      expect(bar).toBe(blockSpec[`.cm-line.quoll-callout-${t}`]?.["--quoll-callout-accent"]);
    }
  });
});
