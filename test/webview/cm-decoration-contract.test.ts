// Cross-cutting contract harness for every CodeMirror decoration provider.
//
// Per-provider unit tests (cm-decoration-*.test.ts) pin each provider's
// behaviour; this file pins the invariants that must hold for ALL providers
// at once, so a newly-added provider (C6c/C7) cannot silently violate one.
// It iterates the live registry `syntaxRevealProviders` (NOT a hand list),
// so new providers auto-enrol. Each invariant ships a negative control
// proving the check is non-vacuous (it goes red on a real violation).
//
// Node environment (no happy-dom): providers are pure functions of
// (tree, selection, visibleRanges); an EditorView/DOM is not needed.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { BuildContext, DecorationProvider } from "../../src/webview/cm/decorations/index.js";
import { arbitrate, syntaxRevealProviders } from "../../src/webview/cm/decorations/index.js";
import { fullTree } from "./helpers/full-tree.js";

// Kitchen-sink document: one example of every construct the registry reveals.
// Line 1 is plain text so nothing sits at offset 0; the trailing newline keeps
// every construct's decoration strictly INTERIOR (no boundary decoration at
// doc.length), which lets the invariant-(iii) full-doc zone drop everything.
// When a new provider is added, add an example of its construct here — the
// coverage guard below fails loudly if a registered provider emits nothing.
const SAMPLE_DOC = [
  "plain paragraph with no markup",
  "",
  "# Heading",
  "",
  "> blockquote line",
  "",
  "para with **bold** *italic* `code` ~~strike~~ and a [link](https://example.com)",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "---",
  "",
  "- plain bullet item",
  "- [ ] todo item",
  "- [x] done item",
  "",
  // A lone `-` under a paragraph parses as a SetextHeading2 whose HeaderMark is
  // a single dash — the nascent-bullet-list shape setextNascentReveal de-styles.
  // Caret-independent, so it emits at the NEUTRAL caret like the coverage guard
  // below requires. `--`/`---` would read as a real heading and stay untouched.
  "nascent setext paragraph",
  "-",
  "",
].join("\n");

// A caret on the plain first line — intersects no construct for any provider,
// so build(single(NEUTRAL)) is the "all hidden" baseline for every provider.
const NEUTRAL = SAMPLE_DOC.indexOf("no markup");

function ctx(
  doc: string,
  selection: EditorSelection,
  visibleRanges?: { from: number; to: number }[]
): BuildContext {
  const state = EditorState.create({
    doc,
    selection,
    // Production (editor.ts) enables multi-selection, so EditorState keeps every
    // range. Without this facet EditorState.create normalises a multi-range
    // selection to its main range and ctx.state.selection would diverge from
    // ctx.selection (an impossible BuildContext). Mirror production exactly.
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  return {
    state,
    // ctx.selection === ctx.state.selection, exactly as computeMerged() builds it.
    selection: state.selection,
    visibleRanges: visibleRanges ?? [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

function build(
  p: DecorationProvider,
  doc: string,
  selection: EditorSelection,
  visibleRanges?: { from: number; to: number }[]
): DecorationSet {
  return p.build(ctx(doc, selection, visibleRanges));
}

type DecoSpec = {
  from: number;
  to: number;
  kind: "mark" | "replace" | "widget";
  cls?: string;
  // Widget identity (constructor name) so sameSpec detects a reveal that swaps
  // widget content/instance rather than toggling presence — the pattern future
  // widget providers (C6c table / C7 image) may use. Without it, JSON.stringify
  // equates two different widgets at the same position and (iv) could go vacuous.
  widget?: string;
};

function specOf(set: DecorationSet): DecoSpec[] {
  const out: DecoSpec[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as {
      class?: string;
      widget?: { constructor?: { name?: string } };
    };
    const kind =
      spec.class !== undefined ? "mark" : spec.widget !== undefined ? "widget" : "replace";
    out.push({
      from: iter.from,
      to: iter.to,
      kind,
      cls: spec.class,
      widget: spec.widget?.constructor?.name,
    });
    iter.next();
  }
  return out;
}

function sameSpec(a: DecoSpec[], b: DecoSpec[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// --- invariant predicates: each returns the VIOLATING decorations ---

function outOfBounds(set: DecorationSet, docLen: number): DecoSpec[] {
  return specOf(set).filter((d) => d.from < 0 || d.to > docLen || d.from > d.to);
}

function outsideWindow(set: DecorationSet, window: { from: number; to: number }): DecoSpec[] {
  return specOf(set).filter((d) => {
    // Zero-width decorations (point widgets) have no interior, so the half-open
    // overlap test would wrongly exclude one sitting exactly at window.from.
    // Treat them as inside when the point lies within [window.from, window.to].
    const inside =
      d.from === d.to
        ? d.from >= window.from && d.from <= window.to
        : d.from < window.to && window.from < d.to;
    return !inside;
  });
}

function overlappingZones(
  set: DecorationSet,
  zones: readonly { from: number; to: number }[]
): DecoSpec[] {
  return specOf(set).filter((d) => zones.some((z) => d.from < z.to && z.from < d.to));
}

// Index-labelled rows so new providers auto-enrol (registry order). The index
// maps to src/webview/cm/decorations/index.ts; failures print provider[i].
const PROVIDERS = syntaxRevealProviders.map((p, i) => [i, p] as const);

describe("decoration provider contract — registry coverage", () => {
  it("every registered provider emits ≥1 decoration on SAMPLE_DOC (fixture non-vacuity)", () => {
    // Guards auto-enrolment: a new provider whose construct is missing from
    // SAMPLE_DOC emits nothing here, failing loudly so the fixture is extended.
    for (const [, p] of PROVIDERS) {
      const set = build(p, SAMPLE_DOC, EditorSelection.single(NEUTRAL));
      expect(specOf(set).length).toBeGreaterThan(0);
    }
  });
});

describe("decoration provider contract — (i) ranges stay within document bounds", () => {
  // Exercise both emission paths: hide (neutral / start / end carets) and
  // reveal (whole-doc selection). A stale or over-absorbing range surfaces as
  // from<0, to>docLen, or from>to.
  const selections = [
    EditorSelection.single(NEUTRAL),
    EditorSelection.single(0),
    EditorSelection.single(SAMPLE_DOC.length),
    EditorSelection.single(0, SAMPLE_DOC.length),
  ];

  it.each(PROVIDERS)("provider[%i] emits no decoration outside [0, doc.length]", (_i, p) => {
    for (const sel of selections) {
      const set = build(p, SAMPLE_DOC, sel);
      expect(outOfBounds(set, SAMPLE_DOC.length)).toEqual([]);
    }
  });

  it("negative control: outOfBounds flags a decoration past doc end", () => {
    const len = SAMPLE_DOC.length;
    const bad = Decoration.set([Decoration.mark({ class: "x" }).range(len - 1, len + 5)]);
    expect(outOfBounds(bad, len).length).toBeGreaterThan(0);
  });
});

describe("decoration provider contract — (ii) ranges stay within the rendered viewport", () => {
  // Repeat SAMPLE_DOC so a mid-document window excludes most constructs; the
  // window is derived from length so it stays interior regardless of doc size.
  const repeated = SAMPLE_DOC.repeat(8);
  const window = {
    from: Math.floor(repeated.length * 0.4),
    to: Math.floor(repeated.length * 0.6),
  };

  it.each(PROVIDERS)("provider[%i] emits nothing outside the supplied viewport window", (_i, p) => {
    const set = build(p, repeated, EditorSelection.single(NEUTRAL), [window]);
    expect(specOf(set).length).toBeGreaterThan(0); // self-sufficient non-vacuity
    expect(outsideWindow(set, window)).toEqual([]);
  });

  it("a mid-document window emits strictly fewer decorations than the whole document", () => {
    // Non-vacuity: proves providers actually honour the window (a provider that
    // walked state.doc would emit the same count for both ranges).
    const whole = { from: 0, to: repeated.length };
    let windowTotal = 0;
    let wholeTotal = 0;
    for (const [, p] of PROVIDERS) {
      windowTotal += specOf(build(p, repeated, EditorSelection.single(NEUTRAL), [window])).length;
      wholeTotal += specOf(build(p, repeated, EditorSelection.single(NEUTRAL), [whole])).length;
    }
    expect(windowTotal).toBeLessThan(wholeTotal);
  });

  it("negative control: outsideWindow flags a decoration beyond the window", () => {
    const bad = Decoration.set([Decoration.mark({ class: "x" }).range(50, 60)]);
    expect(outsideWindow(bad, { from: 0, to: 10 }).length).toBeGreaterThan(0);
  });
});

describe("decoration provider contract — (iii) no decoration survives inside a block-replace zone", () => {
  // The orchestrator does not let providers consult zones; it runs each
  // provider's output through arbitrate() (computeMerged). We mirror that:
  // feed provider output through the production arbitrate() with synthetic
  // zones standing in for the quollBlockReplaceZones facet regions.
  it.each(
    PROVIDERS
  )("provider[%i]: arbitrate() drops every decoration overlapping a full-document zone", (_i, p) => {
    const inline = build(p, SAMPLE_DOC, EditorSelection.single(NEUTRAL));
    expect(specOf(inline).length).toBeGreaterThan(0); // non-vacuity: something to drop
    const zone = [{ from: 0, to: SAMPLE_DOC.length }];
    const arbitrated = arbitrate({ inline, exclusionZones: zone });
    expect(overlappingZones(arbitrated, zone)).toEqual([]);
  });

  it.each(
    PROVIDERS
  )("provider[%i]: a targeted zone drops the overlapping decoration (count strictly decreases)", (_i, p) => {
    const inline = build(p, SAMPLE_DOC, EditorSelection.single(NEUTRAL));
    expect(specOf(inline).length).toBeGreaterThan(0); // self-sufficient non-vacuity
    const first = specOf(inline)[0];
    if (first === undefined) {
      return; // unreachable after the assert (TS narrowing)
    }
    // Straddle the first decoration by ±1 so zero-width widgets overlap too.
    const zone = [
      {
        from: Math.max(0, first.from - 1),
        to: Math.min(SAMPLE_DOC.length, first.to + 1),
      },
    ];
    const arbitrated = arbitrate({ inline, exclusionZones: zone });
    expect(overlappingZones(arbitrated, zone)).toEqual([]);
    expect(specOf(arbitrated).length).toBeLessThan(specOf(inline).length);
  });

  it("negative control: overlappingZones flags an in-zone decoration before arbitration", () => {
    const raw = Decoration.set([Decoration.mark({ class: "x" }).range(5, 9)]);
    expect(overlappingZones(raw, [{ from: 0, to: 20 }]).length).toBeGreaterThan(0);
  });
});

// Build a 2-cursor selection with `mainPos` pinned as the MAIN range regardless
// of whether it sorts before or after `otherPos`. EditorSelection.create re-sorts
// out-of-order ranges but keeps the numeric mainIndex, so a raw
// [cursor(mainPos), cursor(otherPos)] would mis-assign main when otherPos < mainPos
// (a future provider whose construct precedes NEUTRAL). Pin it explicitly so the
// `.selection.main`-only negative control stays effective.
function multiCursorMainAt(mainPos: number, otherPos: number): EditorSelection {
  const ranges = [EditorSelection.cursor(mainPos), EditorSelection.cursor(otherPos)].sort(
    (a, b) => a.from - b.from
  );
  return EditorSelection.create(
    ranges,
    ranges.findIndex((r) => r.from === mainPos)
  );
}

describe("decoration provider contract — (iv) reveal obeys the any-selection rule", () => {
  // Auto-discover, per provider, the first caret offset whose presence flips
  // output away from the all-hidden baseline. Scanning every offset needs no
  // per-provider fixture, so new providers auto-enrol.
  function findRevealingCaret(p: DecorationProvider, baseline: DecoSpec[]): number | null {
    for (let off = 0; off <= SAMPLE_DOC.length; off++) {
      const spec = specOf(build(p, SAMPLE_DOC, EditorSelection.single(off)));
      if (!sameSpec(spec, baseline)) {
        return off;
      }
    }
    return null;
  }

  it.each(
    PROVIDERS
  )("provider[%i]: a non-intersecting extra cursor neither suppresses nor adds reveal", (_i, p) => {
    const baseline = specOf(build(p, SAMPLE_DOC, EditorSelection.single(NEUTRAL)));
    const near = findRevealingCaret(p, baseline);
    if (near === null) {
      // Genuinely selection-insensitive: selecting the whole doc also leaves
      // output unchanged (else the scan missed a reveal). N/A for (iv).
      const all = specOf(build(p, SAMPLE_DOC, EditorSelection.single(0, SAMPLE_DOC.length)));
      expect(all).toEqual(baseline);
      return;
    }
    const nearSpec = specOf(build(p, SAMPLE_DOC, EditorSelection.single(near)));
    expect(nearSpec).not.toEqual(baseline); // sanity: near genuinely reveals

    // Multi-cursor with the NON-intersecting NEUTRAL caret as the MAIN range
    // and `near` secondary. A provider keying on selection.main, or using
    // `.every` instead of `.some`, diverges from nearSpec here.
    const multi = multiCursorMainAt(NEUTRAL, near);
    const multiSpec = specOf(build(p, SAMPLE_DOC, multi));

    expect(multiSpec).toEqual(nearSpec); // a far caret does not change the reveal
    expect(multiSpec).not.toEqual(baseline); // the near caret among many DOES reveal
  });

  it("negative control: an ALL-ranges-must-intersect provider violates the any-selection rule", () => {
    // Synthetic provider with the classic multi-cursor bug: reveals only when
    // EVERY selection range is on the heading line (`.every`, not `.some`).
    const headingFrom = SAMPLE_DOC.indexOf("# Heading");
    const everyProvider: DecorationProvider = {
      build(c) {
        const line = c.state.doc.lineAt(headingFrom);
        const allOnLine = c.selection.ranges.every((r) => r.from <= line.to && r.to >= line.from);
        const deco = allOnLine
          ? Decoration.mark({ class: "reveal" }).range(line.from, line.from + 1)
          : Decoration.replace({}).range(line.from, line.from + 2);
        return Decoration.set([deco]);
      },
    };
    const near = headingFrom + 1; // caret on the heading line
    const nearSpec = specOf(build(everyProvider, SAMPLE_DOC, EditorSelection.single(near)));
    const multi = multiCursorMainAt(NEUTRAL, near);
    const multiSpec = specOf(build(everyProvider, SAMPLE_DOC, multi));
    // The real contract asserts multiSpec === nearSpec; the `.every` bug breaks it.
    expect(sameSpec(multiSpec, nearSpec)).toBe(false);
  });
});
