import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { bulletMarkerReveal } from "../../src/webview/cm/decorations/bullet-marker-reveal.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import { fullTree } from "./helpers/full-tree.js";

function ctx(doc: string, caret: number): BuildContext {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
    selection: EditorSelection.single(caret),
  });
  return {
    state,
    selection: state.selection,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

function ranges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

/** Flatten to `{ from, to, class }` — for depth-class assertions. */
function classes(set: DecorationSet): Array<{ from: number; to: number; class?: string }> {
  const out: Array<{ from: number; to: number; class?: string }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({
      from: iter.from,
      to: iter.to,
      class: (iter.value.spec as { class?: string }).class,
    });
    iter.next();
  }
  return out;
}

describe("bulletMarkerReveal — provider", () => {
  it("emits one mark over each bullet ListMark when the caret is OFF the list lines", () => {
    // "- alpha\n- beta\n\nparagraph": ListMark "-" at [0,1) and [8,9).
    const doc = "- alpha\n- beta\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([
      { from: 0, to: 1 },
      { from: 8, to: 9 },
    ]);
  });

  it("emits Decoration.mark carrying class `quoll-bullet-marker quoll-bullet-marker-d1` (NOT a replace widget)", () => {
    const doc = "- alpha\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    const iter = set.iter();
    const specs: Array<{ class?: string; widget?: unknown }> = [];
    while (iter.value !== null) {
      specs.push(iter.value.spec as { class?: string; widget?: unknown });
      iter.next();
    }
    expect(specs).toHaveLength(1);
    expect(specs[0].class).toBe("quoll-bullet-marker quoll-bullet-marker-d1");
    expect(specs[0].widget).toBeUndefined();
  });

  it("suppresses the mark on the bullet line the caret intersects (reveal-trigger = line)", () => {
    const doc = "- alpha\n- beta\n\nparagraph";
    const set = bulletMarkerReveal.build(ctx(doc, 0)); // caret on line 1
    expect(ranges(set)).toEqual([{ from: 8, to: 9 }]);
  });

  it("intersection is line-wide: caret at end of a bullet's text still reveals its line", () => {
    const doc = "- alpha\n- beta\n\nparagraph";
    const caret = doc.indexOf("alpha") + 5; // end of "alpha", still line 1
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([{ from: 8, to: 9 }]);
  });

  it("skips rendered bullet tasks — taskCheckboxReveal owns `- [ ]` (no dot collision)", () => {
    // line 1 is a task (skip); line 2 is a plain bullet at ListMark [12,13).
    const doc = "- [ ] alpha\n- beta\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([{ from: 12, to: 13 }]);
  });

  it("skips ordered lists — `N.` keeps its numeral", () => {
    const doc = "1. one\n2. two\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([]);
  });

  it("marks `*` and `+` bullets too (any BulletList marker becomes a dot)", () => {
    // "* star\n+ plus\n\nparagraph": ListMark at [0,1) and [7,8).
    const doc = "* star\n+ plus\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([
      { from: 0, to: 1 },
      { from: 7, to: 8 },
    ]);
  });

  it("nested bullets: every level's ListMark gets its own mark", () => {
    // "- outer\n  - inner\n\nparagraph":
    //   line 1 "- outer\n" = 8 bytes → ListMark at [0,1)
    //   line 2 "  - inner" → 2 spaces [8,10), ListMark at [10,11)
    const doc = "- outer\n  - inner\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    expect(ranges(set)).toEqual([
      { from: 0, to: 1 },
      { from: 10, to: 11 },
    ]);
  });

  it("multi-cursor: only the bullet line with no caret keeps its dot", () => {
    // "- a\n- b\n- c": ListMark at [0,1),[4,5),[8,9). Carets on line 1 + line 3.
    const doc = "- a\n- b\n- c";
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        EditorState.allowMultipleSelections.of(true),
      ],
      selection: EditorSelection.create(
        [EditorSelection.cursor(0), EditorSelection.cursor(doc.indexOf("c"))],
        0
      ),
    });
    const set = bulletMarkerReveal.build({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: state.doc.length }],
      tree: fullTree(state),
    });
    expect(ranges(set)).toEqual([{ from: 4, to: 5 }]);
  });

  it("honours ctx.visibleRanges (bullets fully outside the window are not visited)", () => {
    // Window [0,7) covers only line 1; line-2 ListMark at [8,9) is past `to`.
    const doc = "- alpha\n- beta\n\nparagraph";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
      selection: EditorSelection.single(doc.indexOf("paragraph") + 3),
    });
    const set = bulletMarkerReveal.build({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: 7 }],
      tree: fullTree(state),
    });
    expect(ranges(set)).toEqual([{ from: 0, to: 1 }]);
  });

  it("emits NO dot for a content-less bullet task `- [ ]` (checkbox owns the ListMark)", () => {
    const doc = "- [ ]\n\nparagraph";
    const set = bulletMarkerReveal.build(ctx(doc, doc.indexOf("paragraph") + 3));
    expect(ranges(set)).toEqual([]);
  });

  it("still emits a dot for a plain empty bullet `-`", () => {
    const doc = "-\n\nparagraph";
    const set = bulletMarkerReveal.build(ctx(doc, doc.indexOf("paragraph") + 3));
    expect(ranges(set)).toEqual([{ from: 0, to: 1 }]);
  });

  it("drops a ListMark that only TOUCHES the window's closing edge (Lezer touch semantics)", () => {
    // Window [0,8): line-2 ListMark at [8,9) has from === range.to, so touch
    // semantics ENTERS it, but it is not really inside the window. The strict
    // half-open overlap guard drops it. Non-vacuous: without the guard the
    // touch-entered marker emits → this would return [{0,1},{8,9}].
    const doc = "- alpha\n- beta\n\nparagraph";
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage })],
      selection: EditorSelection.single(doc.indexOf("paragraph") + 3),
    });
    const set = bulletMarkerReveal.build({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: 8 }],
      tree: fullTree(state),
    });
    expect(ranges(set)).toEqual([{ from: 0, to: 1 }]);
  });

  it("depth-varied classes: d1/d2/d3 for a 3-level nested bullet chain", () => {
    // "- a\n  - b\n    - c\n\npara": ListMark at [0,1) (d1), [6,7) (d2), [14,15) (d3).
    const doc = "- a\n  - b\n    - c\n\npara";
    const caret = doc.indexOf("para") + 2;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    expect(classes(set).map((c) => c.class)).toEqual([
      "quoll-bullet-marker quoll-bullet-marker-d1",
      "quoll-bullet-marker quoll-bullet-marker-d2",
      "quoll-bullet-marker quoll-bullet-marker-d3",
    ]);
  });

  it("depth is capped at d3: a 4th nesting level still carries d3 (not d4)", () => {
    const doc = "- a\n  - b\n    - c\n      - d\n\npara";
    const caret = doc.indexOf("para") + 2;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    const cls = classes(set).map((c) => c.class);
    expect(cls).toHaveLength(4);
    expect(cls[3]).toBe("quoll-bullet-marker quoll-bullet-marker-d3");
  });

  it("a bullet nested under an ORDERED list carries d2 (visual depth counts OrderedList ancestors too)", () => {
    // "1. one\n   - b\n\npara": ListMark "-" for the nested bullet is on line 2
    // ("   - b"), after 3 leading spaces → offset 7 + 3 = 10.
    const doc = "1. one\n   - b\n\npara";
    const bulletFrom = doc.indexOf("- b");
    const caret = doc.indexOf("para") + 2;
    const set = bulletMarkerReveal.build(ctx(doc, caret));
    const cls = classes(set);
    expect(cls).toHaveLength(1);
    expect(cls[0]).toEqual({
      from: bulletFrom,
      to: bulletFrom + 1,
      class: "quoll-bullet-marker quoll-bullet-marker-d2",
    });
  });
});
