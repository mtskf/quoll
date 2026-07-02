// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  ensureSyntaxTree,
  foldable,
  foldCode,
  foldEffect,
  foldedRanges,
  unfoldEffect,
} from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHEVRON_DOWN_PATH,
  ELLIPSIS_DOT_CX,
  foldPlaceholderDOM,
  headingFoldGutterLineClass,
  markerDOM,
  quollFolding,
} from "../../src/webview/cm/fold/index.js";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy(); // undisposed views leak real timers across tests
  view = null;
});

function mountDoc(doc: string, extra: readonly unknown[] = []): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), quollFolding(), ...(extra as never[])],
    }),
  });
  ensureSyntaxTree(v.state, v.state.doc.length, 5000);
  return v;
}

describe("quollFolding — list folding (delegated to lang-markdown)", () => {
  it("a nested-list parent line is foldable via foldCode (range from lang-markdown)", () => {
    view = mountDoc("- a\n  - b\n  - c\n- d\n");
    view.dispatch({ selection: EditorSelection.cursor(0) }); // caret on "- a"
    expect(foldCode(view)).toBe(true);
    expect(foldedRanges(view.state).size).toBe(1);
  });
});

describe("quollFolding — native auto-unfold (foldState.clearTouchedFolds)", () => {
  it("auto-unfolds when the selection lands inside a folded range", () => {
    view = mountDoc("- a\n  - b\n  - c\n- d\n");
    const line = view.state.doc.lineAt(0);
    const r = foldable(view.state, line.from, line.to);
    view.dispatch({ effects: foldEffect.of(r!) });
    expect(foldedRanges(view.state).size).toBe(1);
    const inside = view.state.doc.toString().indexOf("- b"); // inside the fold
    view.dispatch({ selection: EditorSelection.cursor(inside) });
    expect(foldedRanges(view.state).size).toBe(0); // native clear
  });

  it("auto-unfolds when a real edit (change + caret) lands inside a folded range", () => {
    view = mountDoc("- a\n  - b\n  - c\n- d\n");
    const line = view.state.doc.lineAt(0);
    const r = foldable(view.state, line.from, line.to);
    view.dispatch({ effects: foldEffect.of(r!) });
    const inside = view.state.doc.toString().indexOf("- b");
    // Real typing carries BOTH a change and a selection at the edit point; the
    // selection head inside the fold fires native clearTouchedFolds. (A
    // change-ONLY transaction would map the fold and keep it folded — verified
    // fact #2 — so this test MUST include the selection to mirror real input.)
    view.dispatch({
      changes: { from: inside, insert: "X" },
      selection: EditorSelection.cursor(inside + 1),
    });
    expect(foldedRanges(view.state).size).toBe(0);
  });

  it("does NOT unfold when the caret stays outside every fold", () => {
    view = mountDoc("- a\n  - b\n- d\n");
    const line = view.state.doc.lineAt(0);
    const r = foldable(view.state, line.from, line.to);
    view.dispatch({ effects: foldEffect.of(r!) });
    const dPos = view.state.doc.toString().indexOf("- d");
    view.dispatch({ selection: EditorSelection.cursor(dPos) });
    expect(foldedRanges(view.state).size).toBe(1); // still folded
  });
});

describe("quollFolding — block-widget overlap is safe (review finding #5)", () => {
  it("folding over block widgets does not throw; widgets hide while folded, restore after unfold", async () => {
    // Mount with the real table + image block fields so a fold can overlap them.
    const { tableBlockField } = await import("../../src/webview/cm/table/index.js");
    const { imageBlockField } = await import("../../src/webview/cm/image/index.js");
    const doc = "# H\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![x](y.png)\n";
    view = mountDoc(doc, [tableBlockField, imageBlockField]);
    // `.quoll-block` is the shared block-widget root class (styles-contract.test.ts).
    // If the real table/image widget root class differs, point widgetSel at it.
    const widgetSel = ".quoll-block";
    const range = { from: view.state.doc.lineAt(0).to, to: view.state.doc.length };
    // Fold the whole heading section (spans the table + image block widgets).
    expect(() => view!.dispatch({ effects: foldEffect.of(range) })).not.toThrow();
    expect(foldedRanges(view.state).size).toBe(1);
    // Our custom inline placeholder (foldPlaceholderDOM) replaces CM's default
    // `.cm-foldPlaceholder` box, so the collapsed region renders our pill class.
    expect(view.dom.querySelector(".quoll-fold-placeholder")).not.toBeNull();
    // While folded the inner block widgets are NOT built (the fold replace
    // supersedes — CM's ContentBuilder never descends into the folded range).
    expect(view.dom.querySelector(widgetSel)).toBeNull();
    // Unfolding restores them.
    view.dispatch({ effects: unfoldEffect.of(range) });
    expect(foldedRanges(view.state).size).toBe(0);
    expect(view.dom.querySelector(widgetSel)).not.toBeNull();
  });
});

describe("markerDOM — Lucide chevron SVG (replaces ⌄ / › glyphs)", () => {
  it("renders one chevron-down SVG path in BOTH states (no text glyph)", () => {
    for (const open of [true, false]) {
      const el = markerDOM(open);
      expect(el.classList.contains("quoll-fold-marker")).toBe(true);
      const svg = el.querySelector("svg");
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg!.getAttribute("fill")).toBe("none");
      expect(svg!.getAttribute("stroke")).toBe("currentColor");
      expect(svg!.getAttribute("aria-hidden")).toBe("true");
      const path = svg!.querySelector("path");
      expect(path).not.toBeNull();
      expect(path!.getAttribute("d")).toBe(CHEVRON_DOWN_PATH);
      // Single icon used for both states — no second path, no text glyph.
      expect(svg!.querySelectorAll("path").length).toBe(1);
      expect(el.textContent).toBe("");
    }
  });

  it("toggles the --folded class (rotated right) only when folded, keeps the title tooltip", () => {
    const openEl = markerDOM(true);
    expect(openEl.classList.contains("quoll-fold-marker--folded")).toBe(false);
    expect(openEl.title).toBe("Fold");

    const foldedEl = markerDOM(false);
    expect(foldedEl.classList.contains("quoll-fold-marker--folded")).toBe(true);
    expect(foldedEl.title).toBe("Unfold");
  });
});

describe("foldPlaceholderDOM — inline collapsed-region pill (Lucide ellipsis)", () => {
  // `state.phrase` returns its key verbatim absent a translation, so a minimal
  // stub is enough to exercise the builder's title / aria-label wiring.
  const fakeView = { state: { phrase: (s: string) => s } } as unknown as EditorView;

  it("renders a three-dot Lucide ellipsis SVG in a pill — not CM's default box", () => {
    const el = foldPlaceholderDOM(fakeView, () => {});
    expect(el.classList.contains("quoll-fold-placeholder")).toBe(true);
    // We do NOT reuse `cm-foldPlaceholder`, so CM's bordered-grey box theme never
    // matches — the pill owns its entire look.
    expect(el.classList.contains("cm-foldPlaceholder")).toBe(false);

    const svg = el.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg!.getAttribute("fill")).toBe("none");
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    expect(svg!.getAttribute("aria-hidden")).toBe("true");

    const dots = [...svg!.querySelectorAll("circle")];
    expect(dots.length).toBe(3);
    expect(dots.map((d) => d.getAttribute("cx"))).toEqual(ELLIPSIS_DOT_CX.map(String));
    for (const d of dots) {
      expect(d.getAttribute("cy")).toBe("12");
      expect(d.getAttribute("r")).toBe("1");
    }
    // No text glyph — the old default rendered a literal "…".
    expect(el.textContent).toBe("");
  });

  it("wires the supplied onclick (click-to-unfold) and keeps the unfold tooltip + aria-label", () => {
    let clicked = 0;
    const el = foldPlaceholderDOM(fakeView, () => {
      clicked += 1;
    });
    expect(el.title).toBe("unfold");
    expect(el.getAttribute("aria-label")).toBe("folded content");
    el.click();
    expect(clicked).toBe(1);
  });
});

describe("headingFoldGutterLineClass — per-level gutter tag for the first-row cap", () => {
  // Pins the HEADING-DETECTION contract that drives the per-level `--quoll-fold-row-scale`
  // cap (the PIXEL alignment itself is real-browser-only — happy-dom has no layout).
  function taggedClassByLine(doc: string): Map<number, string> {
    view = mountDoc(doc);
    const set = view.state.field(headingFoldGutterLineClass);
    const byLine = new Map<number, string>();
    const cursor = set.iter();
    while (cursor.value) {
      // gutterLineClass markers are point ranges at the line start.
      expect(cursor.from).toBe(cursor.to);
      const line = view.state.doc.lineAt(cursor.from);
      expect(cursor.from).toBe(line.from);
      byLine.set(line.number, (cursor.value as { elementClass: string }).elementClass);
      cursor.next();
    }
    return byLine;
  }

  it("tags H1/H2/H3 lines with their level class and nothing else", () => {
    // Lines 1-3 headings; line 4 H4 (body-size font, no cap needed); lines 5-7 body+list.
    const byLine = taggedClassByLine(
      "# One\n## Two\n### Three\n#### Four\nbody text\n- item\n  - child\n"
    );
    expect(byLine.get(1)).toBe("quoll-fold-heading-1");
    expect(byLine.get(2)).toBe("quoll-fold-heading-2");
    expect(byLine.get(3)).toBe("quoll-fold-heading-3");
    // H4 and every non-heading line are untagged (default scale 1 = one body row).
    expect(byLine.has(4)).toBe(false);
    expect(byLine.has(5)).toBe(false);
    expect(byLine.has(6)).toBe(false);
    expect(byLine.has(7)).toBe(false);
    expect(byLine.size).toBe(3);
  });

  it("tags a Setext heading underlined with === as level 1", () => {
    // Setext H1: the title line carries SetextHeading1 (heading1 tag → 1.6em).
    const byLine = taggedClassByLine("Title line\n===\n\nbody\n");
    expect(byLine.get(1)).toBe("quoll-fold-heading-1");
    expect(byLine.size).toBe(1);
  });
});
