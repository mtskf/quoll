import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { pointInExclusionZone } from "../../src/webview/cm/decorations/shared.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import {
  blockquotePrefixCols,
  buildListHangIndent,
  listHangNeedsRebuild,
} from "../../src/webview/cm/list/list-hang-indent.js";
import { fullTree } from "./helpers/full-tree.js";

function ctx(doc: string): BuildContext {
  return ctxWithRanges(doc);
}

/** Build a context with explicit visible ranges (defaults to whole-doc). The
 *  ranges variant exercises the per-range emission guard. */
function ctxWithRanges(
  doc: string,
  visibleRanges?: ReadonlyArray<{ from: number; to: number }>
): BuildContext {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return {
    state,
    selection: EditorSelection.single(0),
    visibleRanges: visibleRanges ?? [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

/** Flatten line decorations to { from, style }. Line decorations are points
 *  (from === to) at the line start. */
function lines(set: DecorationSet): Array<{ from: number; style: string }> {
  const out: Array<{ from: number; style: string }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { attributes?: { style?: string } };
    out.push({ from: iter.from, style: spec.attributes?.style ?? "" });
    iter.next();
  }
  return out;
}

describe("list hang-indent provider — plain bullet/ordered", () => {
  it("bullet item: hang = 2ch over a 6px base", () => {
    const set = buildListHangIndent(ctx("- alpha bravo charlie"));
    expect(lines(set)).toEqual([
      {
        from: 0,
        style:
          "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)))",
      },
    ]);
  });

  it("ordered item: hang = 3ch", () => {
    const set = buildListHangIndent(ctx("1. alpha bravo"));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)))"
    );
  });

  it("two-digit ordered item: hang = 4ch", () => {
    expect(lines(buildListHangIndent(ctx("10. alpha")))[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 3 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 3 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)))"
    );
  });

  it("top-level 2-space-indented bullet: hang = 4ch", () => {
    expect(lines(buildListHangIndent(ctx("  - alpha")))[0]?.style).toBe(
      "text-indent:calc(-1 * (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)))"
    );
  });

  it("tab-indented nested bullet: tab expands to tabSize columns (Finding 4)", () => {
    // "- outer\n\t- inner": inner line is "\t- inner"; "\t- " → visual col
    // 4 (tab → 4) + 2 = 6. countColumn expands the tab; raw offset would be 3.
    const got = lines(buildListHangIndent(ctx("- outer\n\t- inner")));
    expect(got[1]?.style).toBe(
      "text-indent:calc(-1 * (5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (7 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("non-list paragraph: no line decoration", () => {
    expect(lines(buildListHangIndent(ctx("just a paragraph")))).toEqual([]);
  });

  it("empty bullet item now hangs like a canonical `- item` (renderable in lock-step)", () => {
    // Was `.toEqual([])` before content-less/empty items were made renderable
    // (the intentional flip — empty items now get `.quoll-list-hang` so they align
    // and gap with siblings). The style matches a canonical `- item` sibling.
    expect(lines(buildListHangIndent(ctx("- ")))).toEqual(
      lines(buildListHangIndent(ctx("- item")))
    );
  });

  it("empty nested bullet gets the SAME hang style as a content-bearing sibling (form b)", () => {
    // `- parent\n  -` vs `- parent\n  - x`: the empty child (line 2) must receive a
    // `.quoll-list-hang` decoration whose style string is byte-identical to its
    // content-bearing sibling's — the CommonMark implied single-space indent makes
    // the two align (assert the expression string, not pixels — happy-dom note).
    const empty = lines(buildListHangIndent(ctx("- parent\n  -")));
    const sibling = lines(buildListHangIndent(ctx("- parent\n  - x")));
    expect(empty[1]).toBeDefined();
    expect(empty[1]?.style).toBe(sibling[1]?.style);
  });

  it("nested sub-list: each ListItem line gets its own hang", () => {
    // "- outer\n  - inner" → outer line 0 (2ch), inner line at offset 8 (4ch).
    const got = lines(buildListHangIndent(ctx("- outer\n  - inner")));
    expect(got).toEqual([
      {
        from: 0,
        style:
          "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)))",
      },
      {
        from: 8,
        style:
          "text-indent:calc(-1 * (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))",
      },
    ]);
  });
});

describe("list hang-indent provider — task lists", () => {
  it("bullet task at top level: hang = checkbox column token (0ch prefix)", () => {
    const set = buildListHangIndent(ctx("- [ ] task body that is long"));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (0 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width)));" +
        "padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (0 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width)))"
    );
  });

  it("nested bullet task under a plain bullet: prefix = whitespace cols + step + token", () => {
    // `- outer\n  - [ ] nested task`: the child bullet task now gains the
    // BULLET_NEST_STEP (parent outer is a plain bullet) → pad 2→4; indent stays 2.
    const set = buildListHangIndent(ctx("- outer\n  - [ ] nested task"));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (2 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)));" +
        "padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (4 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("ordered task: visible `N.` glyph run is split from its trailing space + token", () => {
    // `1. [x]`: the `1.` is 2 glyph cols (sized in the GLYPH blend, like plain
    // ordered), the trailing space is 1 prose-space col, then the checkbox
    // token. Splitting the glyph run fixes the wrapped-continuation under-hang
    // the all-prose-space form left.
    const set = buildListHangIndent(ctx("1. [x] ordered task body"));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)));" +
        "padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)))"
    );
  });
});

describe("list hang-indent provider — plain child nested under a task item", () => {
  // PR2: pad = normalised `Kch + var(...)` form, PLUS NEST_STEP (2ch) so the
  // child is one outline step right of the parent content column (PR1 placed
  // it flush; flush read as un-nested under the wide checkbox). text-indent
  // (the first-line pull) is unchanged.
  it("2-space bullet child: re-based one step past the parent task content column", () => {
    const set = buildListHangIndent(ctx("- [ ] task\n  - nested bullet"));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("tab-indented bullet child: text-indent uses tab-expanded col, hang re-bases +step", () => {
    const set = buildListHangIndent(ctx("- [ ] task\n\t- nested"));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("ordered child under bullet task: child marker width is `N. ` (3ch), +step", () => {
    const set = buildListHangIndent(ctx("- [ ] task\n  1. item here"));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (3 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (3 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width)))"
    );
  });

  it("bullet child under ORDERED task: parent prefix keeps `1.` visible (glyph-split), +step", () => {
    // The child re-bases through the ordered-task parent's rendered content
    // column, which now accounts for the `1.` glyph run in the GLYPH blend
    // (2 glyph cols) instead of 2 prose-space cols. The first-line indent is
    // unchanged (the child's own `-` marker is plain); only the pad re-bases.
    const set = buildListHangIndent(ctx("1. [ ] task\n   - child here"));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (4 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (4 * var(--quoll-prose-space, 1ch) + 3 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
    );
  });
});

describe("list hang-indent provider — task compensation does NOT leak", () => {
  it("plain child under a plain-bullet parent: gains the bullet-nest step, NO task-marker-width leak", () => {
    // `- outer\n  - inner`: pad now carries one BULLET_NEST_STEP (3→5 cols) but
    // still has ZERO var(--quoll-task-marker-width) — no task compensation leaks
    // into a task-free chain.
    const set = buildListHangIndent(ctx("- outer\n  - inner"));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("bullet task child under a plain-bullet parent gains the step (parent-keyed → aligns with plain siblings)", () => {
    // `- outer\n  - [ ] nested task`: the step keys on the PARENT being a plain
    // bullet, so a task child gains it too — keeping mixed plain/task siblings
    // aligned. pad 2→4; the single var(--quoll-task-marker-width) token stands.
    const set = buildListHangIndent(ctx("- outer\n  - [ ] nested task"));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (2 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)));" +
        "padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (4 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
    );
  });
});

describe("list hang-indent provider — multi-level task nesting (F1 + NEST_STEP)", () => {
  it("task child under a task parent: checkbox renders one step past the parent content", () => {
    const set = buildListHangIndent(ctx("- [ ] a\n  - [ ] b"));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (2 * var(--quoll-prose-space, 1ch) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)));" +
        "padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (2 * var(--quoll-prose-space, 1ch) + 2 * var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("task → task → plain: the plain leaf inherits TWO checkbox shifts + TWO steps", () => {
    const set = buildListHangIndent(ctx("- [ ] a\n  - [ ] b\n    - c"));
    expect(lines(set)[2]?.style).toBe(
      "text-indent:calc(-1 * (5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));" +
        "padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + 2 * var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("task → plain → plain: the plain leaf inherits the task shift+step AND its own bullet-nest step", () => {
    const set = buildListHangIndent(ctx("- [ ] a\n  - b\n    - c"));
    expect(lines(set)[2]?.style).toBe(
      "text-indent:calc(-1 * (5 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));" +
        "padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (7 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-task-marker-width) + var(--quoll-list-marker-gap, 0px)))"
    );
  });
});

describe("list hang-indent provider — marker-to-text gap term (list-marker-restyle)", () => {
  it("plain bullet caret-off: the gap term is appended to BOTH text-indent and padding-inline-start", () => {
    const d = "- alpha\nx";
    const style = lines(buildListHangIndent(ctxWithSelection(d, d.length)))[0]?.style ?? "";
    const [indentPart, padPart] = style.split(";");
    expect(indentPart).toContain("var(--quoll-list-marker-gap, 0px)");
    expect(padPart).toContain("var(--quoll-list-marker-gap, 0px)");
  });

  it("bullet task caret-off: the gap term is present AND the checkbox token survives", () => {
    const d = "- [ ] alpha\nx";
    const style = lines(buildListHangIndent(ctxWithSelection(d, d.length)))[0]?.style ?? "";
    expect(style).toContain("var(--quoll-list-marker-gap, 0px)");
    expect(style).toContain("var(--quoll-task-marker-width)");
  });

  it("ordered task caret-off: the gap term is present", () => {
    const d = "1. [ ] alpha\nx";
    const style = lines(buildListHangIndent(ctxWithSelection(d, d.length)))[0]?.style ?? "";
    expect(style).toContain("var(--quoll-list-marker-gap, 0px)");
  });

  it("plain ordered caret-off: NO gap term (only bullets/tasks get the marker gap)", () => {
    const d = "1. alpha\nx";
    const style = lines(buildListHangIndent(ctxWithSelection(d, d.length)))[0]?.style ?? "";
    expect(style).not.toContain("var(--quoll-list-marker-gap");
  });

  it("caret ON a plain bullet line: NO gap term (auto-gated to caret-off only)", () => {
    // Caret placed inside "alpha" on line 1 itself (revealed) — the `ctx()`
    // helper already parks the caret at offset 0 (on this same line), so this
    // mirrors the existing plain-bullet suite's caret-on baseline explicitly.
    const d = "- alpha";
    const style = lines(buildListHangIndent(ctxWithSelection(d, 3)))[0]?.style ?? "";
    expect(style).not.toContain("var(--quoll-list-marker-gap");
  });
});

describe("list hang-indent provider — per-range emission guard", () => {
  it("adjacent visible ranges sharing a boundary emit each line exactly once", () => {
    // Lezer's tree.iterate uses TOUCH semantics (node.from <= range.to), so a
    // ListItem whose line starts exactly at a range boundary is visited in
    // BOTH adjacent ranges. The `emitted` Set de-dups so that line yields one
    // decoration, not two.
    // "- alpha\n- bravo charlie": item 2's line starts at offset 8.
    const doc = "- alpha\n- bravo charlie";
    const boundary = 8; // start of line 2
    const set = buildListHangIndent(
      ctxWithRanges(doc, [
        { from: 0, to: boundary },
        { from: boundary, to: doc.length },
      ])
    );
    // Exactly two decorations — one per item line, NO duplicate at `boundary`.
    expect(lines(set).map((l) => l.from)).toEqual([0, boundary]);
  });

  it("emits the hang when a visible range starts mid-line (line-gap split — Codex #92)", () => {
    // CodeMirror's visibleRanges can begin INSIDE a marker line when a line-gap
    // decoration splits a very long wrapped line — here the only visible range
    // starts at offset 5, past the marker line's start (line.from = 0). The old
    // `line.from < range.from` guard dropped the hang for that line, leaving its
    // soft-wrap continuations un-indented. Now the line still gets its hang.
    // Revert-check: restoring `line.from < range.from || line.from >= range.to`
    // reds this (the decoration set comes back empty).
    const doc = "- alpha bravo charlie delta echo";
    const set = buildListHangIndent(ctxWithRanges(doc, [{ from: 5, to: doc.length }]));
    expect(lines(set).map((l) => l.from)).toEqual([0]);
  });
});

describe("pointInExclusionZone — point-anchor containment", () => {
  it("a point strictly inside [from,to) is contained", () => {
    expect(pointInExclusionZone(4, [{ from: 0, to: 16 }])).toBe(true);
  });
  it("the zone start is contained; the zone end is NOT (half-open upper bound)", () => {
    expect(pointInExclusionZone(0, [{ from: 0, to: 16 }])).toBe(true);
    expect(pointInExclusionZone(16, [{ from: 0, to: 16 }])).toBe(false);
  });
  it("a point past the zone is not contained", () => {
    expect(pointInExclusionZone(17, [{ from: 0, to: 16 }])).toBe(false);
  });
});

describe("listHangIndent — exclusion zones drop hang lines inside the span", () => {
  it("emits a hang line for a list with no zones", () => {
    expect(buildListHangIndent(ctx(`- ${"word ".repeat(40)}`)).size).toBeGreaterThan(0);
  });
  it("drops the hang line when the marker-line anchor falls inside a zone", () => {
    const doc = `- ${"word ".repeat(40)}`;
    expect(buildListHangIndent(ctx(doc), [{ from: 0, to: doc.length }]).size).toBe(0);
  });
  it("keeps a hang line for a list line OUTSIDE the zone", () => {
    const doc = `---\ntitle: x\n---\n\n- ${"word ".repeat(40)}`;
    const fmEnd = "---\ntitle: x\n---".length; // 16
    expect(buildListHangIndent(ctx(doc), [{ from: 0, to: fmEnd }]).size).toBeGreaterThan(0);
  });
});

/** Build a context with the caret at `caret` (parks it OFF a tested line). */
function ctxWithSelection(doc: string, caret: number): BuildContext {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return {
    state,
    selection: EditorSelection.single(caret),
    visibleRanges: [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

/** blockquotePrefixCols for the first line of `doc`, resolving the first
 *  ListItem's ListMark position (the byte anchor the provider passes) so the
 *  content-vs-prefix QuoteMark guard is exercised. */
function prefixColsLine0(doc: string): number {
  const st = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const tree = fullTree(st);
  const line = st.doc.lineAt(0);
  let markerFrom = line.to;
  tree.iterate({
    enter: (n) => {
      if (n.name === "ListItem" && markerFrom === line.to) {
        markerFrom = n.node.firstChild?.from ?? n.from;
      }
    },
  });
  return blockquotePrefixCols(st, tree, { from: line.from, to: line.to }, markerFrom);
}

describe("blockquotePrefixCols — per-QuoteMark hidden width (mirrors blockquote-reveal)", () => {
  it("`> - item`: the `> ` prefix is 2 columns", () => {
    expect(prefixColsLine0("> - item")).toBe(2);
  });
  it("`> 1. item`: the `> ` prefix is 2 columns (list marker excluded)", () => {
    expect(prefixColsLine0("> 1. item")).toBe(2);
  });
  it("`> > - item`: both quote levels hide → 4 columns", () => {
    expect(prefixColsLine0("> > - item")).toBe(4);
  });
  it("`  > - item`: leading spaces before `>` are NOT hidden → 2 (not 4)", () => {
    expect(prefixColsLine0("  > - item")).toBe(2);
  });
  it("`>   - item`: absorb eats the list indent → 4 columns", () => {
    expect(prefixColsLine0(">   - item")).toBe(4);
  });
  it("`>\\t- item`: the tab after `>` is absorbed → 4 columns (tabSize 4)", () => {
    expect(prefixColsLine0(">\t- item")).toBe(4);
  });
  it("plain `- item`: no blockquote mark → 0", () => {
    expect(prefixColsLine0("- item")).toBe(0);
  });
  it("`- > quote`: an inline blockquote as list CONTENT is NOT a prefix → 0", () => {
    // Codex PR#248 review: Lezer parses this ListItem(ListMark, Blockquote(QuoteMark …))
    // — the QuoteMark sits AFTER the list marker, so it is the item's content
    // (blockquote-reveal hides it, but it does not shift the `- ` marker) and
    // must NOT be counted. A naive full-line sum would wrongly report 2.
    expect(prefixColsLine0("- > quote")).toBe(0);
  });
  it("`1. > quote`: inline blockquote after an ordered marker is NOT a prefix → 0", () => {
    expect(prefixColsLine0("1. > quote")).toBe(0);
  });
});

describe("list hang-indent provider — blockquoted lists (selection-aware)", () => {
  // Two blockquoted bullets; caret on line 2 → line 1 is caret-OFF (reveal
  // hides `> `, hang reduces to plain) and line 2 is caret-ON (`> ` shown → full hang).
  const twoItems = "> - alpha\n> - bravo";
  const line2From = twoItems.indexOf("\n") + 1;

  it("caret-off `> - item`: hang reduces to the plain `- item` hang (2ch)", () => {
    const set = buildListHangIndent(ctxWithSelection(twoItems, line2From + 3));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("caret-on `> - item`: full hang keeps the revealed `> ` (4ch)", () => {
    const set = buildListHangIndent(ctxWithSelection(twoItems, line2From + 3));
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)))"
    );
  });

  it("caret-off `> 1. item`: reduces to the plain `1. item` hang (3ch)", () => {
    const d = "> 1. alpha\nx";
    const set = buildListHangIndent(ctxWithSelection(d, d.length)); // caret on line 2
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 2 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2)))"
    );
  });

  it("caret-off `> > - item`: both hidden levels collapse → plain `- item` hang (2ch)", () => {
    const d = "> > - alpha\nx";
    const set = buildListHangIndent(ctxWithSelection(d, d.length));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("caret-off `  > - item`: leading spaces kept → 2-space-indent hang (4ch, NOT collapsed)", () => {
    const d = "  > - alpha\nx";
    const set = buildListHangIndent(ctxWithSelection(d, d.length));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (3 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("caret-off `>   - item`: absorb collapses the list indent → 2ch", () => {
    const d = ">   - alpha\nx";
    const set = buildListHangIndent(ctxWithSelection(d, d.length));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("caret-off `>\\t- item`: tab prefix absorbed → collapses to 2ch (tabSize 4)", () => {
    const d = ">\t- alpha\nx";
    const set = buildListHangIndent(ctxWithSelection(d, d.length));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("caret-off nested `> - outer\\n>   - inner`: inner collapses consistently → 2ch", () => {
    const d = "> - outer\n>   - inner\nx";
    const set = buildListHangIndent(ctxWithSelection(d, d.length)); // caret on the trailing `x`
    // inner is the 2nd hang line (index 1).
    expect(lines(set)[1]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("non-blockquoted list is unchanged regardless of caret (regression guard)", () => {
    const d = "- alpha\nx";
    const set = buildListHangIndent(ctxWithSelection(d, d.length));
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });

  it("caret-off `- > quote` (inline blockquote as list content): NOT over-subtracted → 2ch", () => {
    // Codex PR#248 review regression: the `> ` here is the item's CONTENT (a
    // blockquote), not a prefix that shifts the `- ` marker. A naive full-line
    // QuoteMark sum subtracted its 2 columns → 0ch (marker-flush under-hang);
    // the marker-position guard keeps the plain `- ` hang (2ch).
    const d = "- > quote\nx";
    const set = buildListHangIndent(ctxWithSelection(d, d.length)); // caret on line 2
    expect(lines(set)[0]?.style).toBe(
      "text-indent:calc(-1 * (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)));padding-inline-start:calc(var(--quoll-column-inset-left, 6px) + (1 * var(--quoll-prose-space, 1ch) + 1 * calc((1ch + var(--quoll-prose-space, 1ch)) / 2) + var(--quoll-list-marker-gap, 0px)))"
    );
  });
});

describe("listHangNeedsRebuild — selection-aware rebuild trigger (revert-check)", () => {
  it("a selection-only update triggers a rebuild (blockquote reveal lock-step)", () => {
    const st = EditorState.create({
      doc: "> - a",
      extensions: [markdown({ base: markdownLanguage })],
    });
    // startState === state → the tree-identity and facet clauses are both false
    // (syntaxTree(st) is cached per-state; st.facet(x) === st.facet(x)), so ONLY
    // the selectionSet clause can flip the result. This isolates the NEW trigger:
    // removing `u.selectionSet ||` from listHangNeedsRebuild reds the first
    // assertion (deterministic revert-check, no flaky mounted-view / visibleRanges).
    const base = { docChanged: false, viewportChanged: false, startState: st, state: st };
    expect(listHangNeedsRebuild({ ...base, selectionSet: true } as unknown as ViewUpdate)).toBe(
      true
    );
    expect(listHangNeedsRebuild({ ...base, selectionSet: false } as unknown as ViewUpdate)).toBe(
      false
    );
  });
});
