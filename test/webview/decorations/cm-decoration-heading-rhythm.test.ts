import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState, StateEffect, StateField } from "@codemirror/state";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  buildHeadingRhythm,
  headingRhythmNeedsRebuild,
} from "../../../src/webview/cm/decorations/heading-rhythm.js";
import { quollSyntaxExclusionZones } from "../../../src/webview/cm/decorations/orchestrator.js";
import type { BuildContext } from "../../../src/webview/cm/decorations/types.js";
import { headingRhythmThemeSpec } from "../../../src/webview/cm/theme.js";
import { fullTree } from "../helpers/full-tree.js";

function ctx(doc: string): BuildContext {
  return ctxWithRanges(doc);
}

/** Build a context with explicit visible ranges (defaults to whole-doc). The
 *  ranges variant exercises the per-range TOUCH-de-dup guard. */
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

/** Flatten line decorations to { from, cls }. Line decorations are points
 *  (from === to) at the line start; the rhythm decoration carries only `class`. */
function lines(set: DecorationSet): Array<{ from: number; cls: string }> {
  const out: Array<{ from: number; cls: string }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { class?: string };
    out.push({ from: iter.from, cls: spec.class ?? "" });
    iter.next();
  }
  return out;
}

describe("heading-rhythm provider — per-level content-line tag", () => {
  it("tags a top-level ATX H1 that is NOT the first line", () => {
    // "intro\n\n# H1": line 3 (`# H1`) starts at offset 7.
    const set = buildHeadingRhythm(ctx("intro\n\n# H1"));
    expect(lines(set)).toEqual([{ from: 7, cls: "quoll-heading-rhythm-1" }]);
  });

  it("suppresses a heading on physical line 1 (hugs the top edge)", () => {
    expect(lines(buildHeadingRhythm(ctx("# Top\n\nbody")))).toEqual([]);
  });

  it("tags H2 / H3 / H4 / H5 / H6 with their own level class", () => {
    expect(lines(buildHeadingRhythm(ctx("x\n\n## H2")))[0]?.cls).toBe("quoll-heading-rhythm-2");
    expect(lines(buildHeadingRhythm(ctx("x\n\n### H3")))[0]?.cls).toBe("quoll-heading-rhythm-3");
    expect(lines(buildHeadingRhythm(ctx("x\n\n#### H4")))[0]?.cls).toBe("quoll-heading-rhythm-4");
    expect(lines(buildHeadingRhythm(ctx("x\n\n##### H5")))[0]?.cls).toBe("quoll-heading-rhythm-5");
    expect(lines(buildHeadingRhythm(ctx("x\n\n###### H6")))[0]?.cls).toBe("quoll-heading-rhythm-6");
  });

  it("does NOT tag a blockquote-nested heading (top-level guard)", () => {
    // `> # nested` parses as Blockquote > ATXHeading1 — the parent is Blockquote,
    // not Document, so the panel's own padding-y owns its breathing room.
    expect(lines(buildHeadingRhythm(ctx("x\n\n> # nested")))).toEqual([]);
  });

  it("does NOT tag a plain paragraph", () => {
    expect(lines(buildHeadingRhythm(ctx("intro\n\njust a paragraph")))).toEqual([]);
  });

  it("tags each of two headings on its own line", () => {
    // "x\n# A\n# B": `# A` at offset 2 (line 2), `# B` at offset 6 (line 3).
    const got = lines(buildHeadingRhythm(ctx("x\n# A\n# B")));
    expect(got).toEqual([
      { from: 2, cls: "quoll-heading-rhythm-1" },
      { from: 6, cls: "quoll-heading-rhythm-1" },
    ]);
  });
});

describe("heading-rhythm provider — Setext headings", () => {
  it("single-line Setext H1 (=== underline): tags the title line as level 1", () => {
    // "intro\n\nTitle\n===": the SetextHeading1 starts at the `Title` line (offset 7).
    const got = lines(buildHeadingRhythm(ctx("intro\n\nTitle\n===")));
    expect(got).toEqual([{ from: 7, cls: "quoll-heading-rhythm-1" }]);
  });

  it("single-line Setext H2 (--- underline): tags the title line as level 2", () => {
    const got = lines(buildHeadingRhythm(ctx("intro\n\nTitle\n---")));
    expect(got).toEqual([{ from: 7, cls: "quoll-heading-rhythm-2" }]);
  });

  it("multi-line Setext H2: tags the heading's FIRST text line, not the --- underline", () => {
    // "intro\n\nfoo\nTitle\n---": the SetextHeading2 spans `foo\nTitle`; node.from is
    // the `foo` line (offset 7). Only that line is tagged — NOT the `---` underline.
    const got = lines(buildHeadingRhythm(ctx("intro\n\nfoo\nTitle\n---")));
    expect(got).toEqual([{ from: 7, cls: "quoll-heading-rhythm-2" }]);
  });
});

describe("heading-rhythm provider — nascent lone setext (no heading affordances)", () => {
  // A lone `-`/`=` typed under a paragraph parses as a SetextHeading but reads as
  // a bullet list in progress (see setext-nascent-reveal.ts). The font is demoted
  // there; rhythm padding must be suppressed in lock-step via the shared
  // isNascentLoneSetextHeading predicate — else the paragraph keeps a heading's
  // top spacing while looking like plain text.
  it("does NOT tag a lone `-` underline (nascent SetextHeading2)", () => {
    // "intro\n\nFoo\n-": SetextHeading2 [7,12], HeaderMark [11,12] "-" (lone).
    expect(lines(buildHeadingRhythm(ctx("intro\n\nFoo\n-")))).toEqual([]);
  });

  it("does NOT tag a lone `=` underline (nascent SetextHeading1)", () => {
    expect(lines(buildHeadingRhythm(ctx("intro\n\nFoo\n=")))).toEqual([]);
  });

  it("KEEPS the tag for a real multi-char `---` heading (no regression)", () => {
    // Two-or-more dashes read as an intentional heading → rhythm stays.
    expect(lines(buildHeadingRhythm(ctx("intro\n\nFoo\n---")))).toEqual([
      { from: 7, cls: "quoll-heading-rhythm-2" },
    ]);
  });

  it("KEEPS the suppression for a lone `-`/`=` with a mid-typing trailing space (still lone)", () => {
    // "intro\n\nFoo\n- ": the HeaderMark excludes the trailing space, so the
    // underline mark is still length 1 → nascent → rhythm suppressed. This is the
    // BOUNDARY neighbor of the 2-char case below (revert-check: relaxing
    // `mark.to - mark.from === 1` to `=== 2` reds this — the tag reappears). The
    // predicate's length gate is char-agnostic, so `=` behaves identically to `-`.
    for (const u of ["-", "="]) {
      expect(lines(buildHeadingRhythm(ctx(`intro\n\nFoo\n${u} `)))).toEqual([]);
    }
  });

  it("KEEPS the tag for a real two-char `--`/`==` heading — the boundary next to lone", () => {
    // Exactly two markers is the FIRST length that reads as an intentional heading;
    // it is the boundary immediately above lone. Revert-check: relaxing
    // `mark.to - mark.from === 1` to `>= 1` reds this — the tag is dropped. `==` is
    // a SetextHeading1 (level 1), `--` a SetextHeading2 (level 2); both keep the tag.
    for (const u of ["-", "="]) {
      const cls = u === "=" ? "quoll-heading-rhythm-1" : "quoll-heading-rhythm-2";
      expect(lines(buildHeadingRhythm(ctx(`intro\n\nFoo\n${u}${u}`)))).toEqual([{ from: 7, cls }]);
    }
  });
});

describe("heading-rhythm provider — exclusion zones (frontmatter guard)", () => {
  // A YAML frontmatter body line like `title: y` followed by `---` parses under
  // plain Lezer as a SetextHeading2 DIRECTLY under Document. The fixture keeps that
  // line OFF physical line 1 (it is line 3) so first-line suppression does NOT make
  // the out-of-zone branch vacuous (Codex Conf 88) — the two assertions below then
  // isolate pointInExclusionZone.
  const doc = "intro\n\ntitle: y\n---";
  const setextFrom = 7; // start of "title: y"

  it("tags the Setext-shaped line as level 2 when NO zone covers it", () => {
    expect(lines(buildHeadingRhythm(ctx(doc)))).toEqual([
      { from: setextFrom, cls: "quoll-heading-rhythm-2" },
    ]);
  });

  it("drops the tag when a zone covers the Setext line (Codex Conf 98 regression guard)", () => {
    // Zone [0, end-of-line-3) contains the `title: y` line.from (7) → no decoration.
    expect(lines(buildHeadingRhythm(ctx(doc), [{ from: 0, to: doc.length }]))).toEqual([]);
  });
});

describe("heading-rhythm provider — per-range TOUCH de-dup", () => {
  it("a heading line shared by two adjacent visible ranges is emitted exactly once", () => {
    // Lezer's tree.iterate uses TOUCH semantics, so a heading whose line starts at
    // a range boundary is visited in BOTH ranges; the `emitted` Set de-dups it.
    // "x\n# A\n# B": `# B` line starts at offset 6 (the boundary).
    const doc = "x\n# A\n# B";
    const boundary = 6;
    const set = buildHeadingRhythm(
      ctxWithRanges(doc, [
        { from: 0, to: boundary },
        { from: boundary, to: doc.length },
      ])
    );
    // Exactly two decorations — one per heading line, NO duplicate at `boundary`.
    expect(lines(set).map((l) => l.from)).toEqual([2, 6]);
  });
});

describe("heading-rhythm provider — half-open viewport-overlap guard", () => {
  it("a heading whose line starts EXACTLY at range.to is NOT emitted (closing edge)", () => {
    // "x\n# A\n# B": `# B` line starts at offset 6. A SINGLE visible range that
    // ends exactly at 6 must not emit `# B`: Lezer's TOUCH semantics still enter
    // the node (node.from 6 <= range.to 6), but the line sits at the first offset
    // PAST the drawn range, so a layout-changing line decoration there would
    // violate the viewport-scoped contract. Revert-check: dropping the
    // `line.from < range.to` half of the guard reds this — it comes back as [2, 6].
    const doc = "x\n# A\n# B";
    const set = buildHeadingRhythm(ctxWithRanges(doc, [{ from: 0, to: 6 }]));
    expect(lines(set).map((l) => l.from)).toEqual([2]);
  });

  it("a heading whose line starts BEFORE a mid-line range start is still emitted", () => {
    // The `range.from < line.to` half deliberately KEEPS a heading line that
    // begins before a visibleRange whose start falls mid-line (CM can begin a
    // range mid-line when a line-gap splits a long wrapped line). "intro\n# Heading":
    // the heading line is [6, 15); a range starting at 8 sits inside it.
    // Revert-check: narrowing the guard to gate on `line.from >= range.from` reds
    // this (6 >= 8 is false → the heading would be dropped, losing its rhythm).
    const doc = "intro\n# Heading";
    const set = buildHeadingRhythm(ctxWithRanges(doc, [{ from: 8, to: doc.length }]));
    expect(lines(set).map((l) => l.from)).toEqual([6]);
  });
});

describe("headingRhythmNeedsRebuild — selection-INDEPENDENT rebuild trigger (revert-check)", () => {
  it("rebuilds on docChanged but NOT on a selection-only update", () => {
    const st = EditorState.create({
      doc: "x\n\n# H",
      extensions: [markdown({ base: markdownLanguage })],
    });
    // startState === state → the tree-identity and facet clauses are both false
    // (syntaxTree(st) is cached per-state; st.facet(x) === st.facet(x)), so ONLY the
    // flag under test can flip the result. This isolates the ABSENCE of a
    // selectionSet trigger: adding `u.selectionSet ||` to headingRhythmNeedsRebuild
    // reds the selection-only assertion (deterministic revert-check, the inverse of
    // list-hang's selection-AWARE test).
    const base = { viewportChanged: false, startState: st, state: st };
    expect(
      headingRhythmNeedsRebuild({
        ...base,
        docChanged: true,
        selectionSet: false,
      } as unknown as ViewUpdate)
    ).toBe(true);
    expect(
      headingRhythmNeedsRebuild({
        ...base,
        docChanged: false,
        selectionSet: true,
      } as unknown as ViewUpdate)
    ).toBe(false);
  });

  it("rebuilds when the exclusion-zone facet flips with no doc change", () => {
    // Drive the facet via a StateField + effect so the flip carries neither
    // docChanged nor a tree change — isolating the facet clause (mirrors the fold
    // test's facet-flip guard).
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
    const st = EditorState.create({
      doc: "x\n\n# H",
      extensions: [markdown({ base: markdownLanguage }), zoneField],
    });
    const tr = st.update({ effects: setZones.of([{ from: 0, to: 3 }]) });
    expect(
      headingRhythmNeedsRebuild({
        docChanged: false,
        viewportChanged: false,
        selectionSet: false,
        startState: st,
        state: tr.state,
      } as unknown as ViewUpdate)
    ).toBe(true);
  });
});

describe("headingRhythmThemeSpec — style contract", () => {
  it("maps each level class to its --quoll-heading-space token padding-top", () => {
    expect(headingRhythmThemeSpec[".cm-line.quoll-heading-rhythm-1"].paddingTop).toBe(
      "var(--quoll-heading-space-1, 1.2em)"
    );
    expect(headingRhythmThemeSpec[".cm-line.quoll-heading-rhythm-2"].paddingTop).toBe(
      "var(--quoll-heading-space-2, 1em)"
    );
    expect(headingRhythmThemeSpec[".cm-line.quoll-heading-rhythm-3"].paddingTop).toBe(
      "var(--quoll-heading-space-3, 0.75em)"
    );
  });

  it("groups h4/h5/h6 under one tighter token", () => {
    const grouped =
      headingRhythmThemeSpec[
        ".cm-line.quoll-heading-rhythm-4, .cm-line.quoll-heading-rhythm-5, .cm-line.quoll-heading-rhythm-6"
      ];
    expect(grouped.paddingTop).toBe("var(--quoll-heading-space-4, 0.5em)");
  });
});
