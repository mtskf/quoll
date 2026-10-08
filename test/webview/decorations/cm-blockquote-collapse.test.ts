// @vitest-environment happy-dom
// test/webview/decorations/cm-blockquote-collapse.test.ts
//
// Pins the blockquote "Show more" collapse (blockquote-collapse*.ts): geometry, the
// collapsed / expanded decoration shapes, sticky + auto expansion, the park-on-collapse
// contract, the top-level gate, reseed, and that the feature is VIEW-ONLY (no transaction
// it dispatches changes the document).
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
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
import { hostDocumentReseed } from "../../../src/webview/cm/host-reseed.js";
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
    expect(fd[0].widget).toBeNull(); // not a blockquote widget
    expect(fd[0].from).toBeGreaterThan(bq[0].to);

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
    const callout = `> [!note]\n${lines(12, (k) => `> body ${k}`)}`;
    const doc = `${callout}\n\ntail`;
    const view = mountWith(doc, doc.length, [
      calloutMarkerConcealField,
      blockStyle,
      quollSyntaxReveal(),
    ]);
    // The view is not wedged: the quote's first body line is still rendered.
    const firstLineRendered = (): boolean =>
      (view.dom.querySelector(".cm-content")?.textContent ?? "").includes("body 1");
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
