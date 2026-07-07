// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  ensureSyntaxTree,
  foldAll,
  foldable,
  foldCode,
  foldEffect,
  foldedRanges,
  syntaxTreeAvailable,
  unfoldAll,
  unfoldCode,
  unfoldEffect,
} from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type RangeSet,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView, type GutterMarker } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollSyntaxExclusionZones } from "../../src/webview/cm/decorations/orchestrator.js";
import {
  CHEVRON_DOWN_PATH,
  ELLIPSIS_DOT_CX,
  foldPlaceholderDOM,
  headingFoldGutterLineClass,
  listFoldGutterLineClass,
  markerDOM,
  quollFolding,
  quollFoldKeymap,
  quollFoldKeymapExtension,
} from "../../src/webview/cm/fold/index.js";
import { frontmatterBlockField } from "../../src/webview/cm/frontmatter/index.js";
import {
  expandToEnclosingBlock,
  touchesStructuralReparse,
} from "../../src/webview/cm/structural-guard.js";

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

// A contributor that churns the facet reference every transaction (mimics
// calloutMarkerConcealField, which returns a fresh zones array each docChanged),
// while keeping the CONTENT fixed to `content`.
function churningZoneField(content: readonly { from: number; to: number }[]) {
  return StateField.define<readonly { from: number; to: number }[]>({
    create: () => content.map((z) => ({ ...z })),
    update: () => content.map((z) => ({ ...z })), // fresh array + fresh objects every tx
    provide: (f) => quollSyntaxExclusionZones.from(f),
  });
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
    // Setext H1: the title line carries SetextHeading1 (heading1 tag → 1.8em).
    const byLine = taggedClassByLine("Title line\n===\n\nbody\n");
    expect(byLine.get(1)).toBe("quoll-fold-heading-1");
    expect(byLine.size).toBe(1);
  });

  // The keystroke path recomputes ONLY the changed block (bounded), not the whole
  // syntax tree. These pin that the bounded result stays byte-identical to a full
  // rebuild across heading insert / remove / edit — including the multi-line Setext
  // boundary a naive ±1-line window would miss.
  describe("bounded recompute (keystroke path) — stays equal to a full rebuild", () => {
    function fieldClassesByLine(v: EditorView): Map<number, string> {
      const set = v.state.field(headingFoldGutterLineClass);
      const byLine = new Map<number, string>();
      const cursor = set.iter();
      while (cursor.value) {
        expect(cursor.from).toBe(cursor.to); // point ranges at line starts
        const line = v.state.doc.lineAt(cursor.from);
        expect(cursor.from).toBe(line.from);
        byLine.set(line.number, (cursor.value as { elementClass: string }).elementClass);
        cursor.next();
      }
      return byLine;
    }

    // The full-rebuild oracle: the field freshly created over `doc` (field.create →
    // whole-tree walk). The bounded update must reproduce it.
    function fullRebuildByLine(doc: string): Map<number, string> {
      const fresh = mountDoc(doc);
      const byLine = fieldClassesByLine(fresh);
      fresh.destroy();
      return byLine;
    }

    function expectEqualByLine(a: Map<number, string>, b: Map<number, string>): void {
      expect(Object.fromEntries(a)).toEqual(Object.fromEntries(b));
    }

    it("re-tags a line whose heading level is edited in place (# → ###)", () => {
      view = mountDoc("# One\nbody\n");
      expect(fieldClassesByLine(view).get(1)).toBe("quoll-fold-heading-1");
      // Insert "##" after the first "#" so "# One" becomes "### One".
      view.dispatch({ changes: { from: 1, insert: "##" } });
      const byLine = fieldClassesByLine(view);
      expect(byLine.get(1)).toBe("quoll-fold-heading-3");
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });

    it("tags a newly inserted heading line and drops one deleted mid-doc", () => {
      view = mountDoc("# Keep\n\npara\n\n## Gone\n");
      // Turn "para" into a heading, and delete the "## " off "## Gone".
      view.dispatch({ changes: { from: 8, insert: "### " } }); // "para" → "### para"
      let byLine = fieldClassesByLine(view);
      expect(byLine.get(3)).toBe("quoll-fold-heading-3");
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));

      // Remove the "## " marker from the last heading → it becomes body text.
      const gone = view.state.doc.toString().indexOf("## Gone");
      view.dispatch({ changes: { from: gone, to: gone + 3, insert: "" } });
      byLine = fieldClassesByLine(view);
      const goneLine = view.state.doc.lineAt(view.state.doc.toString().indexOf("Gone")).number;
      expect(byLine.has(goneLine)).toBe(false);
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });

    it("tags the FIRST line when a Setext underline is typed lines below it", () => {
      // The recompute boundary: the change (the `===` line) is three lines BELOW
      // the marker line, so a ±1-line window would miss it. An existing H1 above a
      // blank line must stay retained (it is outside the changed block).
      view = mountDoc("# top\n\nfoo\nbar\nbaz\n");
      // Append a "===\n" underline right after "baz\n" (pos 19) → foo/bar/baz H1.
      view.dispatch({ changes: { from: 19, insert: "===\n" } });
      // Confirm the fast (bounded) path actually ran, not the incomplete-frontier
      // full-rebuild fallback — otherwise this would not exercise the bounding.
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
      const byLine = fieldClassesByLine(view);
      expect(byLine.get(1)).toBe("quoll-fold-heading-1"); // retained ATX heading
      expect(byLine.get(3)).toBe("quoll-fold-heading-1"); // new Setext title line
      expect(byLine.size).toBe(2);
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });

    it("untags a multi-line Setext title when its underline is deleted", () => {
      view = mountDoc("# top\n\nfoo\nbar\nbaz\n===\n");
      expect(fieldClassesByLine(view).get(3)).toBe("quoll-fold-heading-1");
      // Delete the "===\n" underline → foo/bar/baz reverts to a plain paragraph.
      const und = view.state.doc.toString().indexOf("===");
      view.dispatch({ changes: { from: und, to: und + 4, insert: "" } });
      // Confirm the bounded path ran (not the incomplete-frontier full-rebuild
      // fallback) so the Setext-deletion up-walk is actually exercised — the
      // symmetric guard the insertion test carries.
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
      const byLine = fieldClassesByLine(view);
      expect(byLine.get(1)).toBe("quoll-fold-heading-1"); // ATX heading retained
      expect(byLine.has(3)).toBe(false); // Setext gone
      expect(byLine.size).toBe(1);
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });

    it("recomputes both blocks of a multi-range (multi-cursor) transaction", () => {
      // Two disjoint changed ranges in one transaction drive mergeIntervals down
      // its real (length > 1) merge path and the update loop over >1 interval —
      // every other test dispatches a single range and skips both.
      view = mountDoc("## a\n\nbody\n\n### b\n");
      const bFrom = view.state.doc.toString().indexOf("### b");
      // Delete one "#" off each heading in ONE change-set: "## a" → "# a" (H1) and
      // "### b" → "## b" (H2), in separate blank-line-delimited blocks.
      view.dispatch({
        changes: [
          { from: 0, to: 1, insert: "" },
          { from: bFrom, to: bFrom + 1, insert: "" },
        ],
      });
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
      const byLine = fieldClassesByLine(view);
      expect(byLine.get(1)).toBe("quoll-fold-heading-1");
      expect(byLine.get(5)).toBe("quoll-fold-heading-2");
      expect(byLine.size).toBe(2);
      expectEqualByLine(byLine, fullRebuildByLine(view.state.doc.toString()));
    });
  });

  // expandToEnclosingBlock draws the bounded recompute window. Its stop predicate
  // must match the parser's block boundaries: a whitespace-CONTAMINATED blank line
  // is still a Markdown blank line (a boundary), so the walk must not cross it into
  // unrelated blocks (which would resurrect the whole-doc cost the bounding removes).
  describe("expandToEnclosingBlock — Markdown blank-line block boundary", () => {
    function intervalForLine(doc: string, lineNo: number): { from: number; to: number } {
      const state = EditorState.create({ doc });
      const line = state.doc.line(lineNo);
      return expandToEnclosingBlock(state, line.from, line.from + 1);
    }

    it("stops at a truly-empty separator line", () => {
      // "# a" (L1) / "" (L2) / "para" (L3). A change on L3 must not reach the heading.
      const iv = intervalForLine("# a\n\npara\n", 3);
      expect(iv.from).toBe(5); // L3 start — did NOT cross the empty L2 up into L1
    });

    it("stops at a SPACE-only separator (still a Markdown blank line)", () => {
      // "# a" (L1) / " " (L2, one space) / "para" (L3). The space-only line is a
      // Markdown blank line, so the block walk must stop there, not span into L1.
      const iv = intervalForLine("# a\n \npara\n", 3);
      expect(iv.from).toBe(6); // L3 start — space-only L2 is a boundary, not crossed
    });

    it("spans a non-blank run with no interior blank line", () => {
      // No blank separators: a change anywhere in the contiguous run expands to the
      // whole run (this is the multi-line Setext up-walk the bounding relies on).
      const iv = intervalForLine("foo\nbar\nbaz\n", 3);
      expect(iv.from).toBe(0); // walked up across bar/foo (no blank line to stop at)
    });
  });
});

describe("listFoldGutterLineClass — gutter tag for the list-item vertical-gap offset", () => {
  // Pins the LIST-MARKER-DETECTION contract that drives the gutter `padding-top`
  // offset matching the list line's own `--quoll-list-item-gap` breathing room
  // (PR #13). The PIXEL alignment itself is real-browser-only — happy-dom has no
  // layout — so this asserts ONLY that every list-item marker line (and no other)
  // carries the `quoll-fold-list-marker` gutter tag, in lock-step with the
  // `.cm-line.quoll-list-hang` padding it compensates for.
  function taggedLines(doc: string, extra: readonly unknown[] = []): Map<number, string> {
    view = mountDoc(doc, extra);
    const set = view.state.field(listFoldGutterLineClass);
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

  it("tags each bullet / ordered / task list-item marker line and nothing else", () => {
    // 1 bullet parent, 2 nested bullet child, 3 child continuation (no marker),
    // 5 ordered item, 7 task item, 9 plain paragraph, 11 heading. Blank lines
    // (4/6/8/10) keep each construct unambiguous (no lazy-continuation merges).
    const byLine = taggedLines(
      "- parent\n  - child\n    wrapped\n\n1. ordered\n\n- [ ] task\n\nplain\n\n# heading\n"
    );
    expect(byLine.get(1)).toBe("quoll-fold-list-marker");
    expect(byLine.get(2)).toBe("quoll-fold-list-marker");
    expect(byLine.get(5)).toBe("quoll-fold-list-marker");
    expect(byLine.get(7)).toBe("quoll-fold-list-marker");
    // Continuation line, plain paragraph, and heading are untagged by THIS field.
    expect(byLine.has(3)).toBe(false);
    expect(byLine.has(9)).toBe(false);
    expect(byLine.has(11)).toBe(false);
    expect(byLine.size).toBe(4);
  });

  it("does NOT tag a list-item line inside a quollSyntaxExclusionZones span", () => {
    // A frontmatter YAML list parses as markdown ListItems but gets no
    // `.quoll-list-hang` padding (list-hang-indent.ts skips exclusion zones), so
    // the gutter tag must skip it too or a REVEALED frontmatter list would drop
    // the chevron by the gap. Simulate the frontmatter span with a facet value
    // covering lines 1-2; line 4 (outside the zone) stays tagged.
    const doc = "- inside one\n- inside two\n\n- outside\n";
    const zoneEnd = doc.indexOf("\n\n"); // end of "- inside two"
    const byLine = taggedLines(doc, [quollSyntaxExclusionZones.of([{ from: 0, to: zoneEnd }])]);
    expect(byLine.has(1)).toBe(false);
    expect(byLine.has(2)).toBe(false);
    expect(byLine.get(4)).toBe("quoll-fold-list-marker");
    expect(byLine.size).toBe(1);
  });

  it("does NOT tag an empty list item (resolveListItemHang === null)", () => {
    // An empty `- ` item has no content token, so resolveListItemHang returns
    // null and list-hang-indent.ts emits no padding — the gutter tag must skip it
    // in lock-step. The following non-empty item stays tagged.
    const byLine = taggedLines("-\n- has content\n");
    expect(byLine.has(1)).toBe(false);
    expect(byLine.get(2)).toBe("quoll-fold-list-marker");
    expect(byLine.size).toBe(1);
  });

  it("skips a real frontmatter YAML list via the live frontmatterBlockField facet", () => {
    // Integration guard for the facet WIRING (not just a synthetic zone): mount
    // the real frontmatterBlockField in the SAME extension order as editor.ts
    // (quollFolding BEFORE frontmatterBlockField) so a create-time facet-order
    // regression would surface here. A YAML list inside `---` fences parses as
    // markdown ListItems but sits in the frontmatter exclusion span, so it must
    // NOT be tagged; the body list item below the fence must be.
    view = mountDoc("---\ntags:\n  - alpha\n  - beta\n---\n\n- body item\n", [
      frontmatterBlockField,
    ]);
    const set = view.state.field(listFoldGutterLineClass);
    const tagged = new Set<number>();
    const cursor = set.iter();
    while (cursor.value) {
      tagged.add(view.state.doc.lineAt(cursor.from).number);
      cursor.next();
    }
    // Lines 3-4 are the YAML list inside the frontmatter span → excluded.
    expect(tagged.has(3)).toBe(false);
    expect(tagged.has(4)).toBe(false);
    // Line 7 (`- body item`) is below the fence → tagged.
    expect(tagged.has(7)).toBe(true);
    expect(tagged.size).toBe(1);
  });

  it("recomputes the tag set when the exclusion-zone facet flips with no doc change", () => {
    // Pins the facet-change update trigger (the `startState.facet !== state.facet`
    // clause): a zone contributor that flips on a selection-only transaction (no
    // doc edit, no tree change) must still update the gutter tags. Drive the zone
    // via a StateEffect so the flip carries neither docChanged nor a tree change.
    const setZones = StateEffect.define<readonly { from: number; to: number }[]>();
    const zoneField = StateField.define<readonly { from: number; to: number }[]>({
      create: () => [],
      update(value, tr) {
        for (const e of tr.effects) {
          if (e.is(setZones)) {
            return e.value;
          }
        }
        return value;
      },
      provide: (f) => quollSyntaxExclusionZones.from(f),
    });
    view = mountDoc("- alpha\n- beta\n", [zoneField]);
    const tagged = (): Set<number> => {
      const s = new Set<number>();
      const c = (view as EditorView).state.field(listFoldGutterLineClass).iter();
      while (c.value) {
        s.add((view as EditorView).state.doc.lineAt(c.from).number);
        c.next();
      }
      return s;
    };
    expect(tagged()).toEqual(new Set([1, 2])); // no zones → both tagged
    // Flip a zone over line 1 with NO doc change; the tag set must drop line 1.
    view.dispatch({ effects: setZones.of([{ from: 0, to: view.state.doc.line(1).to }]) });
    expect(tagged()).toEqual(new Set([2]));
  });

  it("keeps the field value by reference on a selection-only tx even when the zone facet churns its reference (content unchanged)", () => {
    view = mountDoc("- a\n- b\n", [churningZoneField([])]); // empty zones, but fresh [] each tx
    const before = view.state.field(listFoldGutterLineClass);
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
    const after = view.state.field(listFoldGutterLineClass);
    expect(after).toBe(before); // fix: content-equal churn → return value; bug: rebuilt (new ref)
  });

  describe("bounded recompute (keystroke path) — stays equal to a full rebuild", () => {
    // Codex #2: serialize the ENTIRE RangeSet ({from,to,cls}) and compare arrays —
    // NOT a by-line Map (which collapses duplicate/add-order/extra point ranges a
    // double-add would introduce). This subsumes both `.size` and by-line checks.
    function serializeField(v: EditorView): { from: number; to: number; cls: string }[] {
      const out: { from: number; to: number; cls: string }[] = [];
      const cursor = v.state.field(listFoldGutterLineClass).iter();
      while (cursor.value) {
        out.push({
          from: cursor.from,
          to: cursor.to,
          cls: (cursor.value as { elementClass: string }).elementClass,
        });
        cursor.next();
      }
      return out;
    }
    // Full-rebuild oracle: the field freshly created over `doc` (field.create →
    // whole-tree walk over the default, empty exclusion-zone facet). Valid because
    // the field holds NO sticky path-dependent state — its value is a pure function
    // of (doc, zones).
    function oracle(doc: string): { from: number; to: number; cls: string }[] {
      const fresh = mountDoc(doc);
      const ser = serializeField(fresh);
      fresh.destroy();
      return ser;
    }
    // Assert the bounded field equals the oracle AND that the bounded branch actually
    // ran (syntaxTreeAvailable true — not the incomplete-frontier full-rebuild
    // fallback, which would make the comparison vacuous full≡full).
    function expectBoundedEqualsFull(): void {
      expect(syntaxTreeAvailable(view!.state, view!.state.doc.length)).toBe(true);
      expect(serializeField(view!)).toEqual(oracle(view!.state.doc.toString()));
    }

    it("tags a newly typed list item and drops one whose marker is deleted", () => {
      view = mountDoc("- keep\n\npara\n\n- gone\n");
      const para = view.state.doc.toString().indexOf("para");
      view.dispatch({ changes: { from: para, insert: "- " } }); // "para" → "- para"
      expectBoundedEqualsFull();
      const gone = view.state.doc.toString().indexOf("- gone");
      view.dispatch({ changes: { from: gone, to: gone + 2, insert: "" } }); // "- gone" → "gone"
      expectBoundedEqualsFull();
    });

    it("recomputes both blocks of a multi-range (multi-cursor) transaction", () => {
      view = mountDoc("- a\n\nbody\n\n- b\n");
      const bFrom = view.state.doc.toString().indexOf("- b");
      view.dispatch({
        changes: [
          { from: 0, to: 2, insert: "" }, // "- a" → "a"
          { from: bFrom, to: bFrom + 2, insert: "" }, // "- b" → "b"
        ],
      });
      expect(serializeField(view)).toEqual([]); // both markers gone
      expectBoundedEqualsFull();
    });

    // Adversarial LOOSE-list battery (a loose item spans its interior blank line as
    // ONE ListItem — `- a\n\n  cont` → ListItem[0,11], ListMark on line 1, continuation
    // on line 3, verified against @lezer/markdown). These are the cases the straddle
    // clamp in collectListMarks guards: an edit confined below the interior blank
    // makes expandToEnclosingBlock start BELOW the marker line, yet iterate({from})
    // still ENTERS the straddling item via Lezer TOUCH. Each was verified to FAIL
    // without the clamp (double-add) and PASS with it (2026-07-06 soundness probe).
    it.each([
      [
        "edit a straddling item's continuation",
        "- a\n\n  cont\n",
        (d: string) => [{ from: d.indexOf("cont"), insert: "X" }],
      ],
      [
        "insert a blank between an empty marker and its continuation",
        "-\n  cont\n",
        (d: string) => [{ from: d.indexOf("  cont"), insert: "\n" }],
      ],
      [
        "edit the deep child of a nested loose list",
        "- a\n\n  - b\n\n    c\n",
        (d: string) => [{ from: d.lastIndexOf("c"), insert: "Z" }],
      ],
      [
        "turn a straddling continuation into a nested list item",
        "- a\n\n  cont\n",
        (d: string) => [{ from: d.indexOf("cont"), insert: "- " }],
      ],
      [
        "edit the second body of two loose items",
        "- a\n\n- b\n\n  more\n",
        (d: string) => [{ from: d.indexOf("more"), insert: "!" }],
      ],
    ])("loose-list soundness: %s", (_name, doc, mkChanges) => {
      view = mountDoc(doc);
      view.dispatch({ changes: mkChanges(view.state.doc.toString()) });
      expectBoundedEqualsFull();
    });

    it("stays correct on a docChanged while the zone facet churns its reference (bounded path exercised in production-like churn)", () => {
      view = mountDoc("- keep\n\npara\n\n- gone\n", [churningZoneField([])]);
      const para = view.state.doc.toString().indexOf("para");
      view.dispatch({ changes: { from: para, insert: "- " } }); // "para" → "- para"
      expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
      // Serialize this field, compare to a fresh full build over the same doc + empty zones.
      const ser = (v: EditorView) => {
        const out: { from: number; to: number; cls: string }[] = [];
        const c = v.state.field(listFoldGutterLineClass).iter();
        while (c.value) {
          out.push({
            from: c.from,
            to: c.to,
            cls: (c.value as { elementClass: string }).elementClass,
          });
          c.next();
        }
        return out;
      };
      const fresh = mountDoc(view.state.doc.toString());
      expect(ser(view)).toEqual(ser(fresh));
      fresh.destroy();
    });

    it("recomputes a far list item when the exclusion-zone facet flips IN THE SAME docChanged (Codex #3)", () => {
      // A zone flip changes eligibility OUTSIDE the changed range, so a docChanged that
      // ALSO flips the facet must full-rebuild (the `facetChanged` guard in the
      // docChanged branch), not take the bounded path. Drive the zone via a StateEffect
      // so it rides the SAME transaction as a small, far-away doc edit.
      const setZones = StateEffect.define<readonly { from: number; to: number }[]>();
      const zoneField = StateField.define<readonly { from: number; to: number }[]>({
        create: () => [],
        update(value, tr) {
          for (const e of tr.effects) {
            if (e.is(setZones)) {
              return e.value;
            }
          }
          return value;
        },
        provide: (f) => quollSyntaxExclusionZones.from(f),
      });
      view = mountDoc("- far\n\n- near\n", [zoneField]);
      expect(serializeField(view).length).toBe(2); // both tagged, no zones
      // In ONE transaction: edit "near" (bottom block) AND flip a zone over "- far".
      const near = view.state.doc.toString().indexOf("near");
      view.dispatch({
        changes: { from: near, insert: "X" },
        effects: setZones.of([{ from: 0, to: view.state.doc.line(1).to }]),
      });
      // "- far" is now zoned out → its marker must be GONE even though the edit was far
      // from it. A bounded-only path (missing the facetChanged guard) would strand it.
      // (Can't use the default-facet `oracle` helper here — it mounts without the zone —
      // so assert the tagged line set directly: line 1 dropped, "- near" line retained.)
      const lines = new Set(serializeField(view).map((r) => view!.state.doc.lineAt(r.from).number));
      const nearLine = view.state.doc.lineAt(view.state.doc.toString().indexOf("near")).number;
      expect(lines).toEqual(new Set([nearLine]));
    });
  });
});

// The bounded keystroke recompute (expandToEnclosingBlock) assumes a block's
// identity can only change from WITHIN its own blank-line-delimited run. Markdown
// block boundaries are NOT stable under edits, so a STRUCTURAL reparse can strand /
// miss a fold chevron. `touchesStructuralReparse` routes those edits to a FULL
// rebuild. Each positive case below is bounded==oracle AND is RED against the
// guard-less field (bounded strands a marker); the negative assertions call the
// exported guard directly to pin the perf contract (plain typing stays bounded).
//
// Serialize the WHOLE RangeSet as {from,to,cls}[] (Codex #5/#6 — a by-line Map hides
// duplicate / same-line markers a bad recompute would introduce). The oracle is a
// fresh mount (VALID: all three fold fields are record-less — value is a pure
// function of doc+zones). Both live view and oracle assert syntaxTreeAvailable so the
// bounded branch actually ran (else the comparison is a vacuous full≡full).
function serializeGutter(
  v: EditorView,
  field: StateField<RangeSet<GutterMarker>>
): { from: number; to: number; cls: string }[] {
  const out: { from: number; to: number; cls: string }[] = [];
  const cursor = v.state.field(field).iter();
  while (cursor.value) {
    out.push({
      from: cursor.from,
      to: cursor.to,
      cls: (cursor.value as { elementClass: string }).elementClass,
    });
    cursor.next();
  }
  return out;
}

describe("headingFoldGutterLineClass — bounded ≡ full-rebuild under structural reparse", () => {
  function oracle(doc: string): { from: number; to: number; cls: string }[] {
    const fresh = mountDoc(doc);
    expect(syntaxTreeAvailable(fresh.state, fresh.state.doc.length)).toBe(true);
    const ser = serializeGutter(fresh, headingFoldGutterLineClass);
    fresh.destroy();
    return ser;
  }
  function expectBoundedEqualsFull(): void {
    expect(syntaxTreeAvailable(view!.state, view!.state.doc.length)).toBe(true);
    expect(serializeGutter(view!, headingFoldGutterLineClass)).toEqual(
      oracle(view!.state.doc.toString())
    );
  }

  // The affected heading sits AFTER a blank line, so it is OUTSIDE the changed run's
  // bounded window (expandToEnclosingBlock stops at the blank): a guard-less bounded
  // recompute strands its marker even though the reparse swallowed it.
  it("B1: an unclosed fence inserted above a far heading swallows it (SHAPE fence)", () => {
    view = mountDoc("intro\n\n# h\n");
    expect(serializeGutter(view, headingFoldGutterLineClass).length).toBe(1); // heading tagged
    view.dispatch({ changes: { from: 0, insert: "```\n" } }); // fence now swallows # h
    expect(serializeGutter(view, headingFoldGutterLineClass)).toEqual([]); // heading gone
    expectBoundedEqualsFull();
  });

  it("an unclosed <script> inserted above a far heading swallows it (SHAPE HTML alt)", () => {
    // A type-1 (<script>) block runs to the closing tag across blank lines, so a far
    // heading below a blank is still swallowed (unlike a blank-terminated type-6 block).
    view = mountDoc("intro\n\n# h\n");
    view.dispatch({ changes: { from: 0, insert: "<script>\n" } });
    expect(serializeGutter(view, headingFoldGutterLineClass)).toEqual([]);
    expectBoundedEqualsFull();
  });

  it("typing the closing > of a type-4 <!DOCTYPE> re-reveals a far heading (GT-DELTA only)", () => {
    // The `>` terminator is typed on a PLAIN line (`foo` → `foo>`), so SHAPE /
    // NEWLINE-DELTA / BLANK-FLIP / INDENT-DELTA all miss it — ONLY GT-DELTA fires.
    view = mountDoc("<!DOCTYPE html\nfoo\n\n# h\n"); // unclosed type-4 swallows # h
    expect(serializeGutter(view, headingFoldGutterLineClass)).toEqual([]);
    const fooEnd = view.state.doc.line(2).to; // end of "foo"
    view.dispatch({ changes: { from: fooEnd, insert: ">" } }); // "foo" → "foo>" closes the block
    expect(serializeGutter(view, headingFoldGutterLineClass).length).toBe(1); // # h revealed
    expectBoundedEqualsFull();
  });
});

describe("listFoldGutterLineClass — bounded ≡ full-rebuild under structural reparse", () => {
  function oracle(doc: string): { from: number; to: number; cls: string }[] {
    const fresh = mountDoc(doc);
    expect(syntaxTreeAvailable(fresh.state, fresh.state.doc.length)).toBe(true);
    const ser = serializeGutter(fresh, listFoldGutterLineClass);
    fresh.destroy();
    return ser;
  }
  function expectBoundedEqualsFull(): void {
    expect(syntaxTreeAvailable(view!.state, view!.state.doc.length)).toBe(true);
    expect(serializeGutter(view!, listFoldGutterLineClass)).toEqual(
      oracle(view!.state.doc.toString())
    );
  }

  // The list sits AFTER a blank line so its markers are OUTSIDE the changed run's
  // bounded window — a guard-less bounded recompute strands them post-reparse.
  it("an unclosed fence inserted above a far list swallows its markers (SHAPE fence)", () => {
    view = mountDoc("intro\n\n- one\n- two\n");
    expect(serializeGutter(view, listFoldGutterLineClass).length).toBe(2);
    view.dispatch({ changes: { from: 0, insert: "```\n" } });
    expect(serializeGutter(view, listFoldGutterLineClass)).toEqual([]);
    expectBoundedEqualsFull();
  });

  it("an unclosed <script> inserted above a far list swallows its markers (SHAPE HTML alt)", () => {
    view = mountDoc("intro\n\n- one\n- two\n");
    view.dispatch({ changes: { from: 0, insert: "<script>\n" } });
    expect(serializeGutter(view, listFoldGutterLineClass)).toEqual([]);
    expectBoundedEqualsFull();
  });
});

describe("touchesStructuralReparse — arm falsifiability + perf contract (direct calls)", () => {
  // Construct a real Transaction via state.update({changes}) and call the exported
  // guard directly. Each `=== true` pins one arm (remove that arm → the assertion
  // flips); the `=== false` cases pin that plain typing stays on the bounded hot path
  // (guarding the e5e65ed silent-no-op class).
  function tx(doc: string, changes: { from: number; to?: number; insert?: string }) {
    const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
    return state.update({ changes });
  }

  it("SHAPE (ATX alt): single-line x q → # q fires (no newline/blank/indent/gt)", () => {
    // A bare in-place `x`→`#` — the ATX-heading alt is the ONLY arm that can catch it.
    expect(touchesStructuralReparse(tx("x q\n", { from: 0, to: 1, insert: "#" }))).toBe(true);
  });

  it("SHAPE (underscore alt): typing ___ thematic break fires", () => {
    expect(touchesStructuralReparse(tx("abc\n", { from: 0, to: 3, insert: "___" }))).toBe(true);
  });

  it("SHAPE (HTML alt): typing <div> at line start fires", () => {
    expect(touchesStructuralReparse(tx("abc\n", { from: 0, to: 3, insert: "<div>" }))).toBe(true);
  });

  it("SHAPE (fence alt): typing ``` at line start fires", () => {
    expect(touchesStructuralReparse(tx("abc\n", { from: 0, to: 3, insert: "```" }))).toBe(true);
  });

  it("GT-DELTA: typing a bare > on a plain line fires (type-4 terminator)", () => {
    // No shape, no newline, no blank/indent flip — only the `>` delta catches it.
    expect(touchesStructuralReparse(tx("foo\n", { from: 3, insert: ">" }))).toBe(true);
  });

  it("INDENT-DELTA: unindenting a plain line (  x → x) fires", () => {
    expect(touchesStructuralReparse(tx("  x\n", { from: 0, to: 2, insert: "" }))).toBe(true);
  });

  it("BLANK-FLIP: typing into a blank line fires", () => {
    expect(touchesStructuralReparse(tx("a\n\nb\n", { from: 2, insert: "z" }))).toBe(true);
  });

  it("NEWLINE-DELTA: pressing Enter inside a fenced-code body fires (no in-block exemption)", () => {
    // Record-less fields have NO insideBlock gate: a newline inside a fence still
    // full-rebuilds (an unclosed fence could re-group), unlike the fenced field.
    const doc = "```\ncode\n```\n";
    const codePos = doc.indexOf("code") + 2; // mid "code"
    expect(touchesStructuralReparse(tx(doc, { from: codePos, insert: "\n" }))).toBe(true);
  });

  it("=== false for plain mid-line prose typing (stays bounded)", () => {
    expect(touchesStructuralReparse(tx("hello world\n", { from: 5, insert: "x" }))).toBe(false);
  });

  // SHAPE is DELTA-based, not presence-based: editing the BODY of a line that already
  // starts with a structural marker keeps the marker signature identical old↔new, so the
  // block shape is unchanged and the edit stays on the bounded hot path. RED against the
  // old presence-based SHAPE (which fired on ANY marker-touching slice).
  it("=== false for a list-marker BODY edit (- item → - itemx)", () => {
    expect(touchesStructuralReparse(tx("- item\n", { from: 6, insert: "x" }))).toBe(false);
  });

  it("=== false for an ATX-heading BODY edit (# head → # heads)", () => {
    expect(touchesStructuralReparse(tx("# head\n", { from: 6, insert: "s" }))).toBe(false);
  });

  it("=== false for a blockquote BODY edit (> quote → > quotes)", () => {
    expect(touchesStructuralReparse(tx("> quote\n", { from: 7, insert: "s" }))).toBe(false);
  });

  it("=== false for a fenced info-string edit (```js → ```ts, same fence)", () => {
    // The fence delimiter (``` ) is unchanged; only the info string differs — the fence
    // still opens the same block, so the signature matches and it stays bounded.
    expect(touchesStructuralReparse(tx("```js\n", { from: 3, to: 5, insert: "ts" }))).toBe(false);
  });

  it("=== true when a marker-line body edit ALSO changes the marker (# h → ## h)", () => {
    // Adding a `#` changes the ATX marker shape (H1→H2), so the signature differs → fires.
    expect(touchesStructuralReparse(tx("# h\n", { from: 1, insert: "#" }))).toBe(true);
  });

  it("=== false for a same-line non-structural char edit inside a fenced-code body", () => {
    // Codex Conf 92: the "inside a fence" caveat holds ONLY for a same-line char edit
    // (no newline, no `>`, no shape, no blank/indent flip) — NOT typing generally.
    const doc = "```\ncodeline\n```\n";
    const codePos = doc.indexOf("codeline") + 3;
    expect(touchesStructuralReparse(tx(doc, { from: codePos, insert: "x" }))).toBe(false);
  });

  it("=== true when only ONE of two multi-cursor ranges trips the guard", () => {
    // One range inserts a plain letter (inert); the other inserts `- ` (a list
    // marker) — the guard must short-circuit true on ANY tripping range.
    const state = EditorState.create({
      doc: "alpha\nbravo\n",
      extensions: [markdown({ base: markdownLanguage })],
    });
    const tr = state.update({
      changes: [
        { from: 2, insert: "x" }, // inside "alpha" — inert
        { from: 6, insert: "- " }, // start of "bravo" — list marker
      ],
    });
    expect(touchesStructuralReparse(tr)).toBe(true);
  });

  it("=== false on a non-docChanged (selection-only) transaction", () => {
    const state = EditorState.create({
      doc: "hello\n",
      extensions: [markdown({ base: markdownLanguage })],
    });
    expect(touchesStructuralReparse(state.update({ selection: EditorSelection.cursor(1) }))).toBe(
      false
    );
  });
});

describe("structural guard under Quoll's production language (quollMarkdownLanguage)", () => {
  // Codex #7: the default `markdown({ base: markdownLanguage })` mount is not what
  // ships. Re-run the HTML-swallow and fence cases under the PRODUCTION language so a
  // parser-config divergence (Quoll's re-implemented HTML stack) would surface.
  async function mountProd(doc: string): Promise<EditorView> {
    const { quollMarkdownLanguage } = await import("../../src/webview/cm/markdown.js");
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const v = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [quollMarkdownLanguage(), quollFolding()] }),
    });
    ensureSyntaxTree(v.state, v.state.doc.length, 5000);
    return v;
  }
  async function prodOracle(
    doc: string,
    field: StateField<RangeSet<GutterMarker>>
  ): Promise<{ from: number; to: number; cls: string }[]> {
    const fresh = await mountProd(doc);
    expect(syntaxTreeAvailable(fresh.state, fresh.state.doc.length)).toBe(true);
    const ser = serializeGutter(fresh, field);
    fresh.destroy();
    return ser;
  }

  it("<script> swallow above a far heading: bounded ≡ full (prod language)", async () => {
    view = await mountProd("intro\n\n# h\n");
    view.dispatch({ changes: { from: 0, insert: "<script>\n" } });
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
    expect(serializeGutter(view, headingFoldGutterLineClass)).toEqual(
      await prodOracle(view.state.doc.toString(), headingFoldGutterLineClass)
    );
  });

  it("unclosed fence above a far list: bounded ≡ full (prod language)", async () => {
    view = await mountProd("intro\n\n- one\n- two\n");
    view.dispatch({ changes: { from: 0, insert: "```\n" } });
    expect(syntaxTreeAvailable(view.state, view.state.doc.length)).toBe(true);
    expect(serializeGutter(view, listFoldGutterLineClass)).toEqual(
      await prodOracle(view.state.doc.toString(), listFoldGutterLineClass)
    );
  });
});

describe("quollFoldKeymap — the four fold commands are wired into the keymap", () => {
  it("binds foldCode/unfoldCode/foldAll/unfoldAll to their expected key strings", () => {
    // Pin the wiring CONTRACT via the binding TABLE, not runScopeHandlers: happy-dom's
    // platform detection makes single-variant Mod- chord tests flaky (memory
    // quoll-cm-keymap-test-runscopehandlers-platform-flaky). A silent drop of
    // fold-all/unfold-all — the exact regression the task guards against — turns this red.
    const byCommand = new Map(quollFoldKeymap.map((b) => [b.run, b]));
    expect(quollFoldKeymap.length).toBe(4);
    expect(byCommand.get(foldCode)?.key).toBe("Ctrl-Shift-[");
    expect(byCommand.get(foldCode)?.mac).toBe("Cmd-Alt-[");
    expect(byCommand.get(unfoldCode)?.key).toBe("Ctrl-Shift-]");
    expect(byCommand.get(unfoldCode)?.mac).toBe("Cmd-Alt-]");
    expect(byCommand.get(foldAll)?.key).toBe("Ctrl-Alt-[");
    expect(byCommand.get(unfoldAll)?.key).toBe("Ctrl-Alt-]");
    // fold-all / unfold-all are all-platform single-stroke (no mac override — the
    // workbench Ctrl-K chord leader would swallow VS Code's standard fold-all chord).
    expect(byCommand.get(foldAll)?.mac).toBeUndefined();
    expect(byCommand.get(unfoldAll)?.mac).toBeUndefined();
  });

  it("quollFolding() actually mounts the fold keymap (wiring, not just the table)", () => {
    // The binding-table assertion above proves quollFoldKeymap's CONTENTS but not
    // that quollFolding() mounts it — deleting `quollFoldKeymapExtension` from the
    // returned array would leave that test green (Codex finding 1). This closes the
    // gap by reference-equality: the exact keymap extension object must appear in the
    // composed fold extension. `keymap.of(...)` returns a single extension value, so
    // flattening the returned array and checking identity is non-vacuous and avoids
    // synthetic keydown (flaky in happy-dom — memory
    // quoll-cm-keymap-test-runscopehandlers-platform-flaky). Cast to `unknown[]`
    // before `.flat(Infinity)`: CM's `Extension` is a self-recursive type, and
    // `FlatArray<Extension, Infinity>` blows tsc's instantiation-depth limit (TS2589);
    // `unknown` terminates the FlatArray recursion while the runtime flatten is identical.
    const flat = ([quollFolding()] as unknown[]).flat(Number.POSITIVE_INFINITY);
    expect(flat).toContain(quollFoldKeymapExtension);
  });

  it("foldAll folds every heading section and unfoldAll restores it (Quoll ranges, display-only)", async () => {
    // Mount with Quoll's OWN language so foldAll operates over the SAME heading fold
    // ranges production uses (its re-implemented headerIndent foldService + the
    // nonFoldableBlocks subtraction that makes paragraphs/blockquotes/code non-foldable).
    const { quollMarkdownLanguage } = await import("../../src/webview/cm/markdown.js");
    const doc = "# A\n\ntext a\n\n# B\n\ntext b\n";
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [quollMarkdownLanguage(), quollFolding()] }),
    });
    ensureSyntaxTree(view.state, view.state.doc.length, 5000);

    const before = view.state.doc.toString();
    expect(foldedRanges(view.state).size).toBe(0);

    expect(foldAll(view)).toBe(true);
    // Exactly the two heading sections fold; paragraphs are non-foldable in Quoll's language.
    expect(foldedRanges(view.state).size).toBe(2);
    // Display-only: folding mutates foldState, never the document.
    expect(view.state.doc.toString()).toBe(before);

    expect(unfoldAll(view)).toBe(true);
    expect(foldedRanges(view.state).size).toBe(0);
    expect(view.state.doc.toString()).toBe(before);
  });
});
