// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { EditorView } from "@codemirror/view";
import { type Tag, tags as t } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import {
  BLOCKQUOTE_MAX_DEPTH,
  blockquoteDepthClass,
  blockquoteRule,
  blockStyle,
  buildBlockquoteRule,
  buildFencedCodePanel,
  fencedCodePanel,
} from "../../src/webview/cm/decorations/block-style.js";
import {
  CALLOUT_CLASS,
  CALLOUT_MARKER_CLASS,
  calloutClassForType,
  calloutTypeForLine,
} from "../../src/webview/cm/decorations/callout.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import { blockStyleThemeSpec, quollHighlightSpec } from "../../src/webview/cm/theme.js";
import { fullTree } from "./helpers/full-tree.js";

describe("theme.ts — quollHighlightSpec navy+green token contract (palette refresh)", () => {
  // A spec entry's `tag` is a Tag OR a readonly Tag[] (the monospace entry uses
  // an array); resolve either form.
  const byTag = (tag: Tag) =>
    quollHighlightSpec.find((e) => (Array.isArray(e.tag) ? e.tag.includes(tag) : e.tag === tag));

  it("colours headings with --quoll-accent-blue", () => {
    // Non-vacuous: before the recolour the heading entries carry no `color`.
    expect(String(byTag(t.heading1)?.color)).toMatch(/--quoll-accent-blue/);
    expect(String(byTag(t.heading2)?.color)).toMatch(/--quoll-accent-blue/);
    expect(String(byTag(t.heading3)?.color)).toMatch(/--quoll-accent-blue/);
    // h4/h5/h6 share one spec entry (tag: [t.heading4, t.heading5, t.heading6]).
    expect(String(byTag(t.heading4)?.color)).toMatch(/--quoll-accent-blue/);
  });

  it("colours links/urls with --quoll-accent-green", () => {
    expect(String(byTag(t.link)?.color)).toMatch(/--quoll-accent-green/);
    expect(String(byTag(t.url)?.color)).toMatch(/--quoll-accent-green/);
  });

  it("gives inline code a --quoll-surface-fill background and NO padding (geometry-safe)", () => {
    const mono = byTag(t.monospace);
    expect(String(mono?.backgroundColor)).toMatch(/--quoll-surface-fill/);
    // Geometry-safety rationale: no padding on the inline token (would skew coordsAtPos).
    expect(mono && "padding" in mono).toBe(false);
  });

  it("nested-quote depth-2/-3 rules deepen ONLY the fill (color-mix over the base)", () => {
    const spec = blockStyleThemeSpec as Record<string, Record<string, string>>;
    const d2 = spec[".cm-line.quoll-blockquote-depth-2"];
    const d3 = spec[".cm-line.quoll-blockquote-depth-3"];
    // Both exist and touch ONLY backgroundColor (border/padding/radius stay on
    // the base .quoll-blockquote rule, which both classes co-apply).
    expect(Object.keys(d2 ?? {})).toEqual(["backgroundColor"]);
    expect(Object.keys(d3 ?? {})).toEqual(["backgroundColor"]);
    // color-mix over the surface fill toward the foreground; -3 is the deeper mix.
    expect(d2?.backgroundColor).toMatch(/color-mix.*--quoll-surface-fill.*7%/);
    expect(d3?.backgroundColor).toMatch(/color-mix.*--quoll-surface-fill.*14%/);
  });
});

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

const ctx = (doc: string) => ctxWithRanges(doc);

// Helper: caret OUTSIDE the block (both fences concealed). Default ctx() puts the
// caret at 0, which is ON the open fence line — so fenced tests must set caret.
function ctxCaret(doc: string, caret: number): BuildContext {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [markdown({ base: markdownLanguage })],
  });
  return {
    state,
    selection: state.selection,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

/** Flatten line decorations to { from, cls }. Line decorations are points
 *  (from === to) carrying a `class` spec. */
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

/** Models the cross-plugin union at a shared line: merge by `from`, joining the
 *  passed sets in argument order (callers pass blockquote then fenced). This is
 *  a CLASS-ONLY model of a deterministic order WE choose for the assertion — it
 *  does NOT assert CodeMirror's actual DOM class ordering (which is not a public
 *  API guarantee — Codex 84/92). The real DOM union is asserted order-
 *  independently by the mounted "unions both plugins' classes" test below. */
function mergedLines(...sets: DecorationSet[]): Array<{ from: number; cls: string }> {
  const byFrom = new Map<number, string>();
  for (const set of sets) {
    for (const { from, cls } of lines(set)) {
      const prev = byFrom.get(from);
      byFrom.set(from, prev === undefined ? cls : `${prev} ${cls}`);
    }
  }
  return [...byFrom.entries()].sort(([a], [b]) => a - b).map(([from, cls]) => ({ from, cls }));
}

describe("block-style — fenced code panel (selection-aware fence rows)", () => {
  // L1 "```js"[0,5] L2 "const x = 1;"[6,18] L3 "let y = 2;"[19,29] L4 "```"[30,33]
  const doc = "```js\nconst x = 1;\nlet y = 2;\n```";

  it("caret OUTSIDE: both fence rows collapse; -open/-close move to the body edges", () => {
    // Append a paragraph so the caret can sit OUTSIDE the block (EOF of the bare
    // doc is the end of the close fence line, i.e. ON it).
    const docP = `${doc}\n\npara`;
    const out = buildFencedCodePanel(ctxCaret(docP, docP.indexOf("para") + 2));
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-fenced-code-fence-hidden" },
      { from: 6, cls: "quoll-fenced-code quoll-fenced-code-open" },
      { from: 19, cls: "quoll-fenced-code quoll-fenced-code-close" },
      { from: 30, cls: "quoll-fenced-code-fence-hidden" },
    ]);
  });

  it("caret in the CODE BODY reveals BOTH fences (no fence row collapses)", () => {
    const out = buildFencedCodePanel(ctxCaret(doc, doc.indexOf("const") + 2)); // caret in "const x = 1;" body
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-fenced-code quoll-fenced-code-open" },
      { from: 6, cls: "quoll-fenced-code" },
      { from: 19, cls: "quoll-fenced-code" },
      { from: 30, cls: "quoll-fenced-code quoll-fenced-code-close" },
    ]);
  });

  it("caret INSIDE the block (on close fence line) reveals BOTH fences", () => {
    const out = buildFencedCodePanel(ctxCaret(doc, 31)); // inside the trailing "```"
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-fenced-code quoll-fenced-code-open" },
      { from: 6, cls: "quoll-fenced-code" },
      { from: 19, cls: "quoll-fenced-code" },
      { from: 30, cls: "quoll-fenced-code quoll-fenced-code-close" },
    ]);
  });

  it("single body line, caret outside: the one body line is BOTH -open and -close", () => {
    // L1 "```"[0,3] L2 "code"[4,8] L3 "```"[9,12]
    const d = "```\ncode\n```\n\npara";
    const out = buildFencedCodePanel(ctxCaret(d, d.indexOf("para") + 1));
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-fenced-code-fence-hidden" },
      { from: 4, cls: "quoll-fenced-code quoll-fenced-code-open quoll-fenced-code-close" },
      { from: 9, cls: "quoll-fenced-code-fence-hidden" },
    ]);
  });

  it("unclosed block at EOF: caret inside reveals the open fence; last body line is the bottom edge", () => {
    const out = buildFencedCodePanel(ctxCaret("```js\nconst x = 1;", 18)); // caret in body (in-block)
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-fenced-code quoll-fenced-code-open" },
      { from: 6, cls: "quoll-fenced-code quoll-fenced-code-close" },
    ]);
  });

  it("bodyless block keeps the legacy fence-line panel (no body line to host the edges)", () => {
    // L1 "```"[0,3] L2 "```"[4,7]; caret outside.
    const out = buildFencedCodePanel(
      ctxCaret("```\n```\n\npara", "```\n```\n\npara".indexOf("para") + 1)
    );
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-fenced-code quoll-fenced-code-open" },
      { from: 4, cls: "quoll-fenced-code quoll-fenced-code-close" },
    ]);
  });
});

describe("block-style — blockquote rule", () => {
  it("decorates every quote line incl. the bare `>`; first=open, last=close", () => {
    // L1 "> line one"[0,10] L2 "> line two"[11,21] L3 ">"[22,23] L4 "> line four"[24,35]
    const set = buildBlockquoteRule(ctx("> line one\n> line two\n>\n> line four"));
    expect(lines(set)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 11, cls: "quoll-blockquote" },
      { from: 22, cls: "quoll-blockquote" },
      { from: 24, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  it("single-line blockquote: the one line gets both open AND close", () => {
    expect(lines(buildBlockquoteRule(ctx("> quote")))).toEqual([
      {
        from: 0,
        cls: "quoll-blockquote quoll-blockquote-open quoll-blockquote-close",
      },
    ]);
  });

  it("paints a CommonMark lazy-continuation line (no leading `>`)", () => {
    // "> quoted"[0,8] then "continuation line"[9,26] with NO `>`; Lezer folds
    // both into one Blockquote [0,26]. We paint the whole node span (matching
    // Markdown Studio's whole-<blockquote> treatment), so the continuation
    // line — the node's last line — gets the rule + -close.
    expect(lines(buildBlockquoteRule(ctx("> quoted\ncontinuation line")))).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 9, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });
});

describe("block-style — blockquoteDepthClass (nested deeper tint)", () => {
  it("levels ≤ 1 (base tint) get no depth class", () => {
    expect(blockquoteDepthClass(0)).toBeNull();
    expect(blockquoteDepthClass(1)).toBeNull();
  });

  it("levels 2 and 3 get their own class", () => {
    expect(blockquoteDepthClass(2)).toBe("quoll-blockquote-depth-2");
    expect(blockquoteDepthClass(3)).toBe("quoll-blockquote-depth-3");
  });

  it("deeper nesting caps at BLOCKQUOTE_MAX_DEPTH (3)", () => {
    expect(BLOCKQUOTE_MAX_DEPTH).toBe(3);
    expect(blockquoteDepthClass(4)).toBe("quoll-blockquote-depth-3");
    expect(blockquoteDepthClass(9)).toBe("quoll-blockquote-depth-3");
  });
});

describe("block-style — blockquote rule nested deeper tint", () => {
  it("`> >` lines carry depth-2 ALONGSIDE the base class + open/close edges", () => {
    // "> > a"[0,5] "> > b"[6,11]: both lines have two `>` → depth 2. Outer +
    // inner Blockquote share the first/last line so it is open (L1) / close (L2).
    expect(lines(buildBlockquoteRule(ctx("> > a\n> > b")))).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-depth-2 quoll-blockquote-open" },
      { from: 6, cls: "quoll-blockquote quoll-blockquote-depth-2 quoll-blockquote-close" },
    ]);
  });

  it("mixed depth: only the `> >` line deepens; a `> c` continuation stays depth-1", () => {
    // "> a"[0,3] "> > b"[4,9] "> c"[10,13]. Per-line `>` count: 1, 2, 1 — so only
    // L2 gets depth-2. L2 is the inner quote's OPEN edge; L3 is the shared close.
    expect(lines(buildBlockquoteRule(ctx("> a\n> > b\n> c")))).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 4, cls: "quoll-blockquote quoll-blockquote-depth-2 quoll-blockquote-open" },
      { from: 10, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  it("triple nesting `> > >` gets depth-3", () => {
    expect(lines(buildBlockquoteRule(ctx("> > > deep")))).toEqual([
      {
        from: 0,
        cls: "quoll-blockquote quoll-blockquote-depth-3 quoll-blockquote-open quoll-blockquote-close",
      },
    ]);
  });

  it("depth caps at 3: `> > > >` still reads depth-3", () => {
    expect(lines(buildBlockquoteRule(ctx("> > > > x")))[0]?.cls).toContain(
      "quoll-blockquote-depth-3"
    );
    expect(lines(buildBlockquoteRule(ctx("> > > > x")))[0]?.cls).not.toContain(
      "quoll-blockquote-depth-4"
    );
  });

  it("a plain single-level quote carries NO depth class (regression)", () => {
    expect(lines(buildBlockquoteRule(ctx("> plain")))[0]?.cls).toBe(
      "quoll-blockquote quoll-blockquote-open quoll-blockquote-close"
    );
  });

  it("keeps the depth class when a visible range starts mid-line, past the `>` marks", () => {
    // CodeMirror's visibleRanges can begin INSIDE a line when a line-gap decoration
    // splits a very long wrapped line (list-hang-indent Codex #92). "> a"[0,3]
    // "> > b"[4,9] "> c"[10,13]: a range starting at offset 8 (the `b`) is past line
    // 2's two `>` marks ([4,5],[6,7]) but still paints line 2. quoteMarkCountByLine
    // must line-snap its walk so those marks are still counted → depth-2 survives.
    // Revert-check: dropping the line-snap (walking the raw range) reds this — line 2
    // comes back as bare "quoll-blockquote ... -open" with NO depth-2.
    const set = buildBlockquoteRule(ctxWithRanges("> a\n> > b\n> c", [{ from: 8, to: 13 }]));
    const line2 = lines(set).find((l) => l.from === 4);
    expect(line2?.cls).toContain("quoll-blockquote-depth-2");
  });
});

describe("block-style — blockquote edge migrates off a concealed boundary fence", () => {
  // Whole blockquote is a single-body fenced block; caret OUTSIDE (both fences
  // concealed). The rounded -open/-close must ride the VISIBLE body line (L2),
  // not the zero-height collapsed fence rows (L1/L3).
  // L1 "> ```"[0,5] L2 "> code"[6,12] L3 "> ```"[13,18] L4 ""[19,19] L5 "para"[20,24]
  it("single-body fence as the whole quote: open+close migrate onto the one body line", () => {
    const d = "> ```\n> code\n> ```\n\npara";
    const out = buildBlockquoteRule(ctxCaret(d, d.indexOf("para") + 1));
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-blockquote" },
      { from: 6, cls: "quoll-blockquote quoll-blockquote-open quoll-blockquote-close" },
      { from: 13, cls: "quoll-blockquote" },
    ]);
  });

  // Multi-body fence as the whole quote: -open rides the FIRST body line, -close
  // the LAST body line (distinct lines).
  // L1 "> ```"[0,5] L2 "> a"[6,9] L3 "> b"[10,13] L4 "> ```"[14,19]
  it("multi-body fence as the whole quote: open→first body line, close→last body line", () => {
    const d = "> ```\n> a\n> b\n> ```\n\npara";
    const out = buildBlockquoteRule(ctxCaret(d, d.indexOf("para") + 1));
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-blockquote" },
      { from: 6, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 10, cls: "quoll-blockquote quoll-blockquote-close" },
      { from: 14, cls: "quoll-blockquote" },
    ]);
  });

  // Fence only at the TOP boundary (visible text after it): -open migrates down;
  // -close stays on the last visible text line.
  // L1 "> ```"[0,5] L2 "> code"[6,12] L3 "> ```"[13,18] L4 "> after"[19,26]
  it("fence at the top boundary only: open migrates down, close stays on the trailing text line", () => {
    const d = "> ```\n> code\n> ```\n> after\n\npara";
    const out = buildBlockquoteRule(ctxCaret(d, d.indexOf("para") + 1));
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-blockquote" },
      { from: 6, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 13, cls: "quoll-blockquote" },
      { from: 19, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  // Fence only at the BOTTOM boundary (visible text before it): -open stays on
  // the leading text line; -close migrates up onto the body line.
  // L1 "> before"[0,8] L2 "> ```"[9,14] L3 "> code"[15,21] L4 "> ```"[22,27]
  it("fence at the bottom boundary only: open stays on the leading text line, close migrates up", () => {
    const d = "> before\n> ```\n> code\n> ```\n\npara";
    const out = buildBlockquoteRule(ctxCaret(d, d.indexOf("para") + 1));
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 9, cls: "quoll-blockquote" },
      { from: 15, cls: "quoll-blockquote quoll-blockquote-close" },
      { from: 22, cls: "quoll-blockquote" },
    ]);
  });

  // Caret INSIDE the block (on the open fence line): block-scoped reveal shows
  // BOTH fences, so NEITHER edge migrates — -open/-close stay on the fence lines.
  it("caret inside a boundary fence block reveals both fences: edges stay on the fence lines", () => {
    const d = "> ```\n> code\n> ```\n\npara";
    const out = buildBlockquoteRule(ctxCaret(d, 3)); // inside L1 "> ```"
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 6, cls: "quoll-blockquote" },
      { from: 13, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  // Symmetric (Conf 88): caret INSIDE the block (on the CLOSE fence line) — the
  // block-scoped reveal shows BOTH fences, so neither edge migrates; both -open
  // and -close stay on their fence lines. Pins the close-side contract directly.
  it("caret inside a boundary fence block (near close) reveals both fences: edges stay on the fence lines", () => {
    const d = "> ```\n> code\n> ```\n\npara";
    const out = buildBlockquoteRule(ctxCaret(d, 15)); // inside L3 "> ```" [13,18]
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 6, cls: "quoll-blockquote" },
      { from: 13, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  // Codex #4 — the key block-scoped non-vacuity for edge migration: a caret on the
  // BODY line, on NO fence line at all, still reverts BOTH migrations. Impossible
  // under the old per-line rule, which would migrate both edges for a body caret.
  it("caret in the BODY of a boundary fence block reverts BOTH migrations (block-scoped, not fence-line)", () => {
    const d = "> ```\n> code\n> ```\n\npara";
    const out = buildBlockquoteRule(ctxCaret(d, d.indexOf("code") + 1)); // caret on the BODY line, NOT a fence line
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 6, cls: "quoll-blockquote" },
      { from: 13, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  // Bodyless boundary fence never collapses → never migrates (legacy visible
  // panel). L1 "> ```"[0,5] L2 "> ```"[6,11] is a bodyless fence = the whole quote.
  it("bodyless boundary fence: no migration (fences stay visible)", () => {
    const d = "> ```\n> ```\n\npara";
    const out = buildBlockquoteRule(ctxCaret(d, d.indexOf("para") + 1));
    expect(lines(out)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 6, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  // Conf 89: the OPEN fence line (L1) is OUTSIDE the visible range, but the body
  // line (L2) is INSIDE. `concealableFenceNodes` must still recognise L1 as
  // concealable via the range-STRADDLING FencedCode node (Lezer `iterate` enters
  // any node overlapping the range; landmarks come from the FULL node, not the
  // clamp), so -open still migrates onto the visible L2. NON-VACUOUS: if the
  // straddling node were missed, `concealable` would be empty → -open would be
  // lost and -close would wrongly stay on L3. Built inline (needs BOTH a custom
  // caret AND custom visibleRanges; the shared helpers set one or the other).
  it("boundary fence line outside the visible range still migrates the edge onto the in-range body line", () => {
    const d = "> ```\n> code\n> ```\n\npara"; // L1[0,5] L2[6,12] L3[13,18]
    const state = EditorState.create({
      doc: d,
      selection: EditorSelection.single(d.indexOf("para") + 1), // caret outside (both fences concealed)
      extensions: [markdown({ base: markdownLanguage })],
    });
    const set = buildBlockquoteRule({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 6, to: 18 }], // excludes L1 (the open fence), includes L2 + L3
      tree: fullTree(state),
    });
    expect(lines(set)).toEqual([
      { from: 6, cls: "quoll-blockquote quoll-blockquote-open quoll-blockquote-close" },
      { from: 13, cls: "quoll-blockquote" },
    ]);
  });
});

describe("block-style — gating & clamping", () => {
  it("non-block prose: no decorations", () => {
    expect(lines(buildBlockquoteRule(ctx("just a paragraph")))).toEqual([]);
    expect(lines(buildFencedCodePanel(ctx("just a paragraph")))).toEqual([]);
  });

  it("skips a line whose start is inside an exclusion zone", () => {
    // "> a"[0,3] "> b"[4,7]; zone covers L1's start only. L2 (from=4) is the
    // Blockquote node's LAST line, so it still carries the -close modifier.
    const set = buildBlockquoteRule(ctx("> a\n> b"), [{ from: 0, to: 1 }]);
    expect(lines(set)).toEqual([{ from: 4, cls: "quoll-blockquote quoll-blockquote-close" }]);
  });

  it("clamps emission to visible ranges; caret in-block keeps body lines bare (both fences revealed)", () => {
    // Visible range = L2+L3 of the 4-line fence; default caret = 0 (in-block).
    // Both fences reveal, so neither body line takes a relocated edge.
    const set = buildFencedCodePanel(
      ctxWithRanges("```js\nconst x = 1;\nlet y = 2;\n```", [{ from: 6, to: 29 }])
    );
    expect(lines(set)).toEqual([
      { from: 6, cls: "quoll-fenced-code" },
      { from: 19, cls: "quoll-fenced-code" },
    ]);
  });

  it("does not bleed past a visible range ending at the next line's start", () => {
    // "> a"[0,3] "> b"[4,7] "> c"[8,11]; Blockquote [0,11]. The visible range
    // [0,8) ends EXACTLY at L3's line.from (8, exclusive). L3 must NOT be
    // emitted — pins the `clampTo - 1` exclusive-end clamp (without it,
    // lineAt(8) = L3 would surface a stray line at the viewport edge).
    const set = buildBlockquoteRule(ctxWithRanges("> a\n> b\n> c", [{ from: 0, to: 8 }]));
    expect(lines(set)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 4, cls: "quoll-blockquote" },
    ]);
  });

  it("emits nothing for a zero-width visible range at the block edge", () => {
    // Range [7,7] over "> a\n> b" (Blockquote [0,7]): clampFrom (7) >= clampTo
    // (7) → the guard skips emission. Without the guard, lineAt(7-1=6) would
    // wrongly emit L2 for an empty range.
    const set = buildBlockquoteRule(ctxWithRanges("> a\n> b", [{ from: 7, to: 7 }]));
    expect(lines(set)).toEqual([]);
  });
});

describe("block-style — multi-range dedup", () => {
  // Pins the per-line `byLine` Map dedup invariant: when the same block node
  // is visited from two overlapping visibleRanges (L2 from=4 appears in both
  // range1=[0,7] and range2=[4,11]), each line must be emitted exactly once.
  // The `byLine` Map uses line.from as key, so revisiting a line from a second
  // range re-uses the same Set and idempotently re-adds already-present class
  // tokens, so each line is emitted exactly once. Without this dedup the line
  // would be emitted twice — and RangeSetBuilder does NOT reject that (two line
  // decorations at an equal `from`/`startSide` is a permitted non-strict
  // increase, not a throw), so the duplicate would pass silently and this test
  // catches the regression via the emitted-line count mismatch (4 instead of
  // 3), not via a builder throw.
  //
  // Doc: "> a"[0,3] "> b"[4,7] "> c"[8,11] — Blockquote node [0, 11]
  // range1=[0,7]  covers L1+L2; range2=[4,11] covers L2+L3.
  // L2 (from=4) is touched by both ranges.
  it("same block line visited from two visibleRanges is emitted only once", () => {
    const set = buildBlockquoteRule(
      ctxWithRanges("> a\n> b\n> c", [
        { from: 0, to: 7 },
        { from: 4, to: 11 },
      ])
    );
    expect(lines(set)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 4, cls: "quoll-blockquote" },
      { from: 8, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  it("nested structure + overlapping visibleRanges: composed classes emitted exactly once per line", () => {
    // "> ```"[0,5] "> code"[6,12] "> ```"[13,18]
    // Blockquote [0,18], FencedCode [2,18]; both span L1-L3.
    // range1=[0,12] covers L1+L2; range2=[6,18] covers L2+L3.
    // L2 (from=6) is touched by both ranges for BOTH nodes.
    const c = ctxWithRanges("> ```\n> code\n> ```", [
      { from: 0, to: 12 },
      { from: 6, to: 18 },
    ]);
    expect(mergedLines(buildBlockquoteRule(c), buildFencedCodePanel(c))).toEqual([
      {
        from: 0,
        cls: "quoll-blockquote quoll-blockquote-open quoll-fenced-code quoll-fenced-code-open",
      },
      { from: 6, cls: "quoll-blockquote quoll-fenced-code" },
      {
        from: 13,
        cls: "quoll-blockquote quoll-blockquote-close quoll-fenced-code quoll-fenced-code-close",
      },
    ]);
  });
});

describe("block-style — mixed block types", () => {
  // Pins independent open/close decoration for FencedCode and Blockquote in
  // the same document. Verifies that the BLOCK_CLASSES dispatch assigns the
  // correct base/open/close classes to each block type and that they do not
  // bleed into each other's lines.
  //
  // Doc: "```"[0,3] "code"[4,8] "```"[9,12] ""[13,13] "> quote"[14,21]
  //   FencedCode [0, 12]: single-body-line block; caret OUTSIDE (on the quote)
  //     so BOTH fences collapse to the hidden class and the body line L2 takes
  //     the relocated -open AND -close.
  //   Blockquote [14, 21]: nodeFirstLine=L5(14), nodeLastLine=L5(14)
  it("fenced code followed by blockquote: both emit independent open/close", () => {
    const c = ctxCaret(
      "```\ncode\n```\n\n> quote",
      "```\ncode\n```\n\n> quote".indexOf("> quote") + 2
    );
    expect(mergedLines(buildBlockquoteRule(c), buildFencedCodePanel(c))).toEqual([
      { from: 0, cls: "quoll-fenced-code-fence-hidden" },
      { from: 4, cls: "quoll-fenced-code quoll-fenced-code-open quoll-fenced-code-close" },
      { from: 9, cls: "quoll-fenced-code-fence-hidden" },
      { from: 14, cls: "quoll-blockquote quoll-blockquote-open quoll-blockquote-close" },
    ]);
  });
});

describe("block-style — nested constructs compose classes", () => {
  // Reproduce-first for the Codex Conf 98 dedup limitation: a line covered by
  // more than one styled block node must accumulate the UNION of every node's
  // classes, not let the first-visited node win. Lezer enters parent before
  // child, so before the compositional rewrite the outer Blockquote claimed
  // every line (dedup by line.from) and the inner FencedCode / Blockquote was
  // skipped entirely — the panel vanished and the inner node's open/close
  // modifiers were dropped.

  it("fenced code inside a blockquote: line carries BOTH the quote rule and the fenced-code panel", () => {
    // "> ```"[0,5] "> code"[6,12] "> ```"[13,18]
    //   Blockquote [0,18]: first=L1(0), last=L3(13)
    //   FencedCode [2,18]: first=L1(0), last=L3(13)  (nested under Blockquote)
    // Default caret = 0 (in-block): block-scoped reveal shows BOTH fences, so
    // neither the fenced NOR the blockquote edge migrates — L1 keeps base+open
    // (quote AND fenced), L3 keeps base+close (quote AND fenced), and the single
    // body line L2 stays bare. No boundary-fence collapse when the caret is in-block.
    const c = ctx("> ```\n> code\n> ```");
    expect(mergedLines(buildBlockquoteRule(c), buildFencedCodePanel(c))).toEqual([
      {
        from: 0,
        cls: "quoll-blockquote quoll-blockquote-open quoll-fenced-code quoll-fenced-code-open",
      },
      { from: 6, cls: "quoll-blockquote quoll-fenced-code" },
      {
        from: 13,
        cls: "quoll-blockquote quoll-blockquote-close quoll-fenced-code quoll-fenced-code-close",
      },
    ]);
  });

  it("nested `> >` blockquotes: the inner node's open/close compose onto its own first/last line", () => {
    // "> outer"[0,7] "> > inner"[8,17] "> outer2"[18,26]
    //   outer Blockquote [0,26]: first=L1(0), last=L3(18)
    //   inner Blockquote [10,26]: first=L2(8), last=L3(18)
    // L2 is the inner node's FIRST line, so it gains -open (it carried only the
    // bare "quoll-blockquote" before — outer's middle line, inner skipped). It
    // also carries -depth-2 (two leading `>` → the nested deeper-tint class).
    // Both nodes share the base class, so the Set dedups it to a single rule.
    const set = buildBlockquoteRule(ctx("> outer\n> > inner\n> outer2"));
    expect(lines(set)).toEqual([
      { from: 0, cls: "quoll-blockquote quoll-blockquote-open" },
      { from: 8, cls: "quoll-blockquote quoll-blockquote-depth-2 quoll-blockquote-open" },
      { from: 18, cls: "quoll-blockquote quoll-blockquote-close" },
    ]);
  });

  it("single-line doubly-nested `> > deep`: outer + inner open/close all land on the one line", () => {
    // "> > deep"[0,8]
    //   outer Blockquote [0,8]: first=last=L1(0)
    //   inner Blockquote [2,8]: first=last=L1(0)
    // The one line is every node's first AND last line, so it accumulates the
    // base + open + close (deduped across the two same-name nodes), plus -depth-2
    // (two leading `>`).
    expect(lines(buildBlockquoteRule(ctx("> > deep")))).toEqual([
      {
        from: 0,
        cls: "quoll-blockquote quoll-blockquote-depth-2 quoll-blockquote-open quoll-blockquote-close",
      },
    ]);
  });
});

describe("block-style — theme spec contract", () => {
  it("fenced-code panel: theme-aware background + 0.9em monospace", () => {
    const base = blockStyleThemeSpec[".cm-line.quoll-fenced-code"];
    expect(base.backgroundColor).toMatch(/--quoll-surface-fill/);
    // Host + hard fallbacks are retained in the var() chain for the pre-theme-class frame.
    expect(base.backgroundColor).toMatch(/--vscode-textCodeBlock-background/);
    expect(base.backgroundColor).toMatch(/rgba\(255,\s*255,\s*255,\s*0\.05\)/);
    expect(base.fontSize).toBe("0.9em");
    expect(base.fontFamily).toMatch(/--vscode-editor-font-family/);
  });

  it("fenced-code corners: token elliptical radius (background-clip compensation) + shared vertical padding on open/close only", () => {
    // The panel fill is clipped to the PADDING box (background-clip:padding-box, to
    // inset it to the body-text column), so the border eats into the corner radius.
    // The outer radii are elliptical — `--quoll-block-radius + 6px` (left, 6px
    // border) / `+ 2px` (right, 2px border) horizontal, with the token as the
    // vertical radius — so the PAINTED fill corner is a true --quoll-block-radius
    // round (see theme.ts). Padding + radius come from the SHARED :root token pair.
    // REVERT-CHECK: reverting to a border-box-clipped plain radius (dropping the
    // `+ 6px`/`+ 2px` border compensation) turns these red.
    const open = blockStyleThemeSpec[".cm-line.quoll-fenced-code-open"];
    expect(open.borderTopLeftRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + 6px) var(--quoll-block-radius, 8px)"
    );
    expect(open.borderTopRightRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + 2px) var(--quoll-block-radius, 8px)"
    );
    expect(open.paddingTop).toBe("var(--quoll-block-pad-y, 12px)");
    const close = blockStyleThemeSpec[".cm-line.quoll-fenced-code-close"];
    expect(close.borderBottomLeftRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + 6px) var(--quoll-block-radius, 8px)"
    );
    expect(close.borderBottomRightRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + 2px) var(--quoll-block-radius, 8px)"
    );
    expect(close.paddingBottom).toBe("var(--quoll-block-pad-y, 12px)");
  });

  it("blockquote corners: token elliptical radius (background-clip compensation) + shared vertical padding on open/close only", () => {
    // Mirrors the fenced-code panel: the opening quote line rounds its top
    // corners, the closing line its bottom corners, so the navy fill reads as a
    // rounded panel. The radii are elliptical (`--quoll-block-radius + 6px` left /
    // `+ 2px` right horizontal, token vertical) to compensate for
    // `background-clip:padding-box` — the transparent border eats the corner, so the
    // outer radius is bumped by the border width to leave a true --quoll-block-radius
    // painted round (see theme.ts). Padding + radius are the SAME :root token pair
    // the fenced-code corners use, so the two panels can never drift. REVERT-CHECK:
    // reverting to a border-box-clipped plain radius turns these red. Real-pixel
    // curve is left to the browser harness.
    const open = blockStyleThemeSpec[".cm-line.quoll-blockquote-open"];
    expect(open.borderTopLeftRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + 6px) var(--quoll-block-radius, 8px)"
    );
    expect(open.borderTopRightRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + 2px) var(--quoll-block-radius, 8px)"
    );
    expect(open.paddingTop).toBe("var(--quoll-block-pad-y, 12px)");
    const close = blockStyleThemeSpec[".cm-line.quoll-blockquote-close"];
    expect(close.borderBottomLeftRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + 6px) var(--quoll-block-radius, 8px)"
    );
    expect(close.borderBottomRightRadius).toBe(
      "calc(var(--quoll-block-radius, 8px) + 2px) var(--quoll-block-radius, 8px)"
    );
    expect(close.paddingBottom).toBe("var(--quoll-block-pad-y, 12px)");
  });

  it("both panels source horizontal padding from ONE shared --quoll-block-pad-x token (unification contract)", () => {
    // The whole point of the token: the fenced-code panel and the blockquote must
    // draw their interior inset from the SAME :root token so they can never drift
    // in unit OR amount again (before this, fenced-code used `1em` and blockquote
    // `8px`). Horizontal padding is --quoll-block-pad-x (16px); the vertical inset
    // is the separate, tighter --quoll-block-pad-y (12px), pinned on the -open/-close
    // corner tests above. Pin that both sides are the identical horizontal token
    // string. REVERT-CHECK: hardcoding either back to `1em`/`8px` (or giving them
    // different values) turns this red. Real-pixel 16px inset is confirmed in the
    // browser harness.
    const fenced = blockStyleThemeSpec[".cm-line.quoll-fenced-code"] as Record<string, unknown>;
    const quote = blockStyleThemeSpec[".cm-line.quoll-blockquote"] as Record<string, unknown>;
    const pad = "var(--quoll-block-pad-x, 16px)";
    expect(fenced.paddingLeft).toBe(pad);
    expect(fenced.paddingRight).toBe(pad);
    expect(quote.paddingLeft).toBe(pad);
    expect(quote.paddingRight).toBe(pad);
    // Same source → identical string on both surfaces.
    expect(quote.paddingLeft).toBe(fenced.paddingLeft);
  });

  it("blockquote: subtle navy fill + muted text, no VISIBLE left rule", () => {
    const bq = blockStyleThemeSpec[".cm-line.quoll-blockquote"] as Record<string, unknown>;
    // The green left rule was removed (user decision 2026-07-01): the navy fill
    // alone affords "this is a quote". The borderLeft that now exists is the
    // TRANSPARENT column-inset border (background-clip mechanism — see the inset
    // test below), NOT a coloured rule. REVERT-CHECK: giving borderLeft a visible
    // colour (re-adding the rule) turns this assertion red.
    expect(bq.borderLeft).toBe("6px solid transparent");
    expect(bq.backgroundColor).toMatch(/--quoll-surface-fill/);
    expect(bq.color).toMatch(/--vscode-descriptionForeground/);
  });

  it("blockquote + fenced fill insets to the body-text column via a transparent border + background-clip (not margin)", () => {
    // Regression guard for the centred-column overflow (2026-06-30, re-reported
    // 2026-07-01). ROOT CAUSE: the navy fill is a .cm-line background; a .cm-line is
    // width:auto in the centred .cm-content column, so its border-box fills
    // .cm-content's CONTENT box — but CM's base `.cm-line { padding: 0 2px 0 6px }`
    // insets BODY text by 6px/2px, so a border-box-clipped fill sat 6px/2px OUTSIDE
    // the body-text column ("wider than paragraphs"). (#225 tried box-sizing +
    // padding; box-sizing is a no-op while width is auto, and padding only moves the
    // INNER text, so the bleed survived — that earlier guard's "no margin allowed"
    // premise was itself backwards, since a horizontal margin SHRINKS a width:auto
    // border-box.) FIX: a TRANSPARENT 6px/2px border reserves the base inset and
    // `background-clip: padding-box` paints the tint only inside it, landing the
    // fill on the body-text column WITHOUT shrinking the line's layout box (border-
    // box stays full width; a margin was deliberately rejected so CM's line geometry
    // and the block-widget height invariant stay untouched). This pins that contract:
    //   (1) the transparent left/right border reserving CM's 6px/2px text inset;
    //   (2) background-clip:padding-box painting the fill inside it;
    //   (3) NO margin (would move the layout box) and NO explicit width.
    // box-sizing:border-box is retained as defence if a width is ever added. Real-
    // pixel alignment across widths + click→caret accuracy are verified in the
    // browser harness (happy-dom has no layout — fenced-collapse precedent). REVERT-
    // CHECK: dropping the border or the background-clip from either spec (reverting
    // to a border-box-clipped full-width fill) turns these assertions red.
    for (const sel of [".cm-line.quoll-blockquote", ".cm-line.quoll-fenced-code"] as const) {
      const spec = blockStyleThemeSpec[sel] as Record<string, unknown>;
      expect(spec.borderLeft).toBe("6px solid transparent");
      expect(spec.borderRight).toBe("2px solid transparent");
      expect(spec.backgroundClip).toBe("padding-box");
      expect(spec.boxSizing).toBe("border-box");
      for (const forbidden of [
        "width",
        "minWidth",
        "maxWidth",
        "margin",
        "marginLeft",
        "marginRight",
      ]) {
        expect(forbidden in spec).toBe(false);
      }
    }
  });

  it("hidden fence row collapses to zero height (no position — that is the copy theme's job)", () => {
    const hidden = blockStyleThemeSpec[".cm-line.quoll-fenced-code-fence-hidden"];
    expect(hidden.height).toBe("0");
    expect(hidden.lineHeight).toBe("0");
    expect(hidden.paddingTop).toBe("0");
    expect(hidden.paddingBottom).toBe("0");
    // Must NOT clip the absolutely-positioned copy button.
    expect("overflow" in hidden).toBe(false);
  });

  it("hidden fence rule stays the LAST blockStyleThemeSpec key (defensive source-order guard, belt-and-suspenders after the blockquote edge migration)", () => {
    // Codex #1: was an equal-specificity source-order dependency for nested
    // fences — a collapsed boundary fence row co-carrying quoll-blockquote-open/
    // -close. The blockquote edge migration (block-style.ts) now moves those
    // edges onto the visible body line, so that co-occurrence no longer happens;
    // this key-order check is now a belt-and-suspenders defensive guard, kept
    // because the order is still deliberately maintained.
    const keys = Object.keys(blockStyleThemeSpec);
    const hiddenIdx = keys.indexOf(".cm-line.quoll-fenced-code-fence-hidden");
    expect(hiddenIdx).toBe(keys.length - 1);
    expect(hiddenIdx).toBeGreaterThan(keys.indexOf(".cm-line.quoll-blockquote-close"));
  });
});

describe("block-style — plugin rebuild triggers (caret move)", () => {
  function mountBoth(doc: string, caret: number): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      // Register the `blockStyle` AGGREGATE (exactly as editor.ts does), so this
      // test also exercises CM flattening the Extension array into both plugins
      // — `view.plugin(blockquoteRule)` / `view.plugin(fencedCodePanel)` still
      // resolve the individual instances (Codex 90).
      extensions: [markdown({ base: markdownLanguage }), blockStyle],
    });
    return new EditorView({ state, parent });
  }

  it("a selection-only transaction rebuilds the fenced panel but NOT the blockquote rule", () => {
    // Doc: a blockquote then a fenced block. Caret starts OUTSIDE the fence
    // (both fences concealed); moving it ONTO the open fence line reveals that
    // fence → the fenced geometry changes → fencedCodePanel recomputes. The
    // blockquote rule is selection-independent → its decoration set OBJECT is
    // reused (update() skips the recompute on a selectionSet-only transaction).
    const doc = "> quote one\n> quote two\n\n```js\nconst x = 1;\n```\n\npara";
    const view = mountBoth(doc, doc.indexOf("para")); // caret outside the fence
    const bqBefore = view.plugin(blockquoteRule)?.decorations;
    const fcBefore = view.plugin(fencedCodePanel)?.decorations;
    // Non-vacuity guards: BOTH sets are genuinely non-empty (the blockquote AND
    // the fenced block both render in the full-doc happy-dom viewport), so reuse
    // of the SAME blockquote object means "did not rebuild" (not "empty
    // singleton"), and a DIFFERENT fenced object means a real recompute of
    // non-empty content (Codex 85).
    expect(bqBefore?.size).toBeGreaterThan(0);
    expect(fcBefore?.size).toBeGreaterThan(0);
    view.dispatch({ selection: { anchor: doc.indexOf("```js") + 1 } }); // onto the open fence
    const bqAfter = view.plugin(blockquoteRule)?.decorations;
    const fcAfter = view.plugin(fencedCodePanel)?.decorations;
    // Blockquote rule: SAME object → update() did NOT recompute on selectionSet.
    // The blockquote here (lines 1-2) has NO fence at either boundary, so the
    // cached `hasConcealableBoundaryFence` flag is false and the conditional
    // selectionSet trigger is short-circuited — the selection-independence
    // optimization is preserved for the common case.
    // REVERT-CHECK: removing the `&& hasConcealableBoundaryFence` guard (making
    // selectionSet unconditional) turns this `toBe` red (a fresh equal-content
    // set ≠ the old object).
    expect(bqAfter).toBe(bqBefore);
    // Fenced panel: NEW object → it DID recompute (selection-aware).
    expect(fcAfter).not.toBe(fcBefore);
    view.destroy();
  });

  it("a selection change that toggles a boundary-fence blockquote DOES rebuild the blockquote rule", () => {
    // The blockquote IS a single-body fenced block, so its first/last line is a
    // concealable fence → hasConcealableBoundaryFence is true. Moving the caret
    // from OUTSIDE the quote (both fences concealed → -open/-close migrated onto
    // the body line) ONTO the open fence line reveals it → the -open edge moves
    // back onto the fence line → the blockquote decoration set changes. So the
    // gated selectionSet trigger MUST fire (new object).
    const doc = "> ```\n> code\n> ```\n\npara";
    const view = mountBoth(doc, doc.indexOf("para") + 1); // caret outside the quote
    const bqBefore = view.plugin(blockquoteRule)?.decorations;
    expect(bqBefore?.size).toBeGreaterThan(0); // non-vacuity: genuinely non-empty
    view.dispatch({ selection: { anchor: 3 } }); // onto the open fence line (L1 "> ```")
    const bqAfter = view.plugin(blockquoteRule)?.decorations;
    // NEW object → the gated selectionSet trigger fired for a boundary-fence quote.
    // REVERT-CHECK: dropping the conditional selectionSet trigger from
    // blockquoteRule.update() turns this `not.toBe` red (stale reused object).
    expect(bqAfter).not.toBe(bqBefore);
    view.destroy();
  });

  it("a blockquote with an INTERIOR fence (not at a boundary) does NOT rebuild on a caret move", () => {
    // Conf 86: the fence sits in the MIDDLE of the quote, so the blockquote's
    // first ("> text") and last ("> more") lines are TEXT, not fences →
    // hasConcealableBoundaryFence is false → the gated selectionSet trigger is
    // short-circuited even though a fence exists inside the quote. Pins that the
    // gate keys on BOUNDARY fences, not "any fence in the blockquote".
    const doc = "> text\n> ```\n> code\n> ```\n> more";
    const view = mountBoth(doc, doc.indexOf("more")); // caret outside the interior fence
    const bqBefore = view.plugin(blockquoteRule)?.decorations;
    expect(bqBefore?.size).toBeGreaterThan(0); // non-vacuity: genuinely non-empty
    view.dispatch({ selection: { anchor: doc.indexOf("```") + 1 } }); // onto the interior open fence
    const bqAfter = view.plugin(blockquoteRule)?.decorations;
    // SAME object → the interior fence is not a boundary, so the flag is false and
    // update() short-circuits the selectionSet. REVERT-CHECK: computing the flag
    // as "any fence in the quote" instead of "fence at a boundary line" would
    // turn this `toBe` red.
    expect(bqAfter).toBe(bqBefore);
    view.destroy();
  });

  it("CodeMirror unions both plugins' classes on a nested `> ```` ` line", () => {
    // Mounted regression guard for the cross-plugin union the mergedLines helper
    // models: a `> ```` ` line must carry BOTH the blockquote rule and the fenced
    // panel classes on the SAME .cm-line element. Guards against dropping a
    // plugin from editor.ts or a CM change to line-decoration class merging.
    const doc = "> ```\n> code\n> ```"; // caret 0 → on the open fence line
    const view = mountBoth(doc, 0);
    const firstLine = view.contentDOM.querySelector(".cm-line");
    const cls = firstLine?.className ?? "";
    expect(cls).toContain("quoll-blockquote");
    expect(cls).toContain("quoll-fenced-code");
    view.destroy();
  });
});

describe("calloutTypeForLine — [!TYPE] admonition marker grammar", () => {
  it("matches each of the five GitHub/Obsidian types", () => {
    expect(calloutTypeForLine("> [!NOTE]")).toBe("note");
    expect(calloutTypeForLine("> [!TIP]")).toBe("tip");
    expect(calloutTypeForLine("> [!IMPORTANT]")).toBe("important");
    expect(calloutTypeForLine("> [!WARNING]")).toBe("warning");
    expect(calloutTypeForLine("> [!CAUTION]")).toBe("caution");
  });
  it("is case-insensitive and normalises to lowercase", () => {
    expect(calloutTypeForLine("> [!note]")).toBe("note");
    expect(calloutTypeForLine("> [!Tip]")).toBe("tip");
  });
  it("allows an Obsidian title and/or a fold suffix after the marker", () => {
    expect(calloutTypeForLine("> [!NOTE] Custom title")).toBe("note");
    expect(calloutTypeForLine("> [!NOTE]-")).toBe("note");
    expect(calloutTypeForLine("> [!WARNING]+ heads up")).toBe("warning");
  });
  it("strips a nested quote prefix and extra whitespace", () => {
    expect(calloutTypeForLine("> > [!CAUTION]")).toBe("caution");
    expect(calloutTypeForLine(">  [!WARNING]")).toBe("warning");
  });
  it("returns null for an unknown type (generic-panel fallback)", () => {
    expect(calloutTypeForLine("> [!FOO]")).toBeNull();
    expect(calloutTypeForLine("> [!NOTEX]")).toBeNull();
  });
  it("returns null when the marker is not the whole leading token", () => {
    expect(calloutTypeForLine("> [!NOTE]x")).toBeNull();
    expect(calloutTypeForLine("> [!NOTE]-x")).toBeNull();
    expect(calloutTypeForLine("> just a quote")).toBeNull();
    expect(calloutTypeForLine("> text [!NOTE]")).toBeNull();
  });
  it("does not mistake a `>`-indented CODE BLOCK for a callout", () => {
    // CommonMark: 4+ spaces after the `>` marker make the content an indented
    // code block (Lezer parses `>` + ≥5 spaces + text as Blockquote > CodeBlock),
    // so `[!NOTE]` inside it is code, not a marker. The whitespace cap rejects it.
    expect(calloutTypeForLine(">     [!NOTE]")).toBeNull(); // > + 5 spaces → CodeBlock
    expect(calloutTypeForLine(">      [!NOTE]")).toBeNull(); // > + 6 spaces → CodeBlock
    expect(calloutTypeForLine("    > [!NOTE]")).toBeNull(); // 4 leading spaces → top-level code
    // …but 1–4 spaces after `>` stay a paragraph (Lezer), so still a callout:
    expect(calloutTypeForLine(">    [!NOTE]")).toBe("note"); // > + 4 spaces → Paragraph
  });
  it("calloutClassForType returns the per-type theme hook", () => {
    expect(calloutClassForType("warning")).toBe("quoll-callout-warning");
    expect(CALLOUT_CLASS).toBe("quoll-callout");
    expect(CALLOUT_MARKER_CLASS).toBe("quoll-callout-marker");
  });
});

describe("block-style — callout admonition classes", () => {
  it("a `[!WARNING]` blockquote gets per-type classes on every line + marker on the first", () => {
    const doc = "> [!WARNING]\n> stay alert";
    const out = lines(buildBlockquoteRule(ctxCaret(doc, doc.length)));
    // First (marker) line: base + callout + per-type + marker.
    expect(out[0]?.cls).toContain("quoll-blockquote");
    expect(out[0]?.cls).toContain("quoll-callout");
    expect(out[0]?.cls).toContain("quoll-callout-warning");
    expect(out[0]?.cls).toContain("quoll-callout-marker");
    // Body line: callout + per-type, but NOT the marker class.
    expect(out[1]?.cls).toContain("quoll-callout");
    expect(out[1]?.cls).toContain("quoll-callout-warning");
    expect(out[1]?.cls).not.toContain("quoll-callout-marker");
  });

  it("each of the five types selects its own per-type class", () => {
    for (const [marker, cls] of [
      ["> [!NOTE]", "quoll-callout-note"],
      ["> [!TIP]", "quoll-callout-tip"],
      ["> [!IMPORTANT]", "quoll-callout-important"],
      ["> [!WARNING]", "quoll-callout-warning"],
      ["> [!CAUTION]", "quoll-callout-caution"],
    ] as const) {
      const out = lines(buildBlockquoteRule(ctx(marker)));
      expect(out[0]?.cls).toContain(cls);
      expect(out[0]?.cls).toContain("quoll-callout-marker");
    }
  });

  it("an unknown `[!FOO]` falls back to the generic panel (no callout class)", () => {
    const out = lines(buildBlockquoteRule(ctx("> [!FOO]\n> body")));
    expect(out[0]?.cls).toContain("quoll-blockquote");
    expect(out[0]?.cls).not.toContain("quoll-callout");
    expect(out[1]?.cls).not.toContain("quoll-callout");
  });

  it("a `>`-indented code block whose text looks like `[!NOTE]` gets no callout class", () => {
    // `> ` + 5 spaces makes `[!NOTE]` an indented code block (Lezer), not a marker.
    const out = lines(buildBlockquoteRule(ctx(">     [!NOTE]")));
    expect(out[0]?.cls).toContain("quoll-blockquote");
    expect(out[0]?.cls).not.toContain("quoll-callout");
  });

  it("a plain quote is unchanged (no callout class)", () => {
    const out = lines(buildBlockquoteRule(ctx("> just a quote")));
    expect(out[0]?.cls).toBe("quoll-blockquote quoll-blockquote-open quoll-blockquote-close");
  });

  it("nested callout: the outer container type wins; the inner emits no type class", () => {
    // Line 2 (`> > [!NOTE]`) is inside the outer WARNING callout. The inner
    // Blockquote is nested → emits no callout class, so line 2 is warning, not note.
    const doc = "> [!WARNING]\n> > [!NOTE]";
    const out = lines(buildBlockquoteRule(ctxCaret(doc, doc.length)));
    expect(out[1]?.cls).toContain("quoll-callout-warning");
    expect(out[1]?.cls).not.toContain("quoll-callout-note");
  });

  it("a doubly-nested `> > [!NOTE]` is still a note callout via the outermost node", () => {
    const out = lines(buildBlockquoteRule(ctx("> > [!NOTE]")));
    expect(out[0]?.cls).toContain("quoll-callout-note");
    expect(out[0]?.cls).toContain("quoll-callout-marker");
  });

  it("the `[!TYPE]` marker round-trips byte-identically (decoration-only)", () => {
    const doc = "> [!NOTE]\n> body text\n> more";
    const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
    // Building the decorations touches no document text.
    buildBlockquoteRule({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: state.doc.length }],
      tree: fullTree(state),
    });
    expect(state.doc.toString()).toBe(doc);
  });
});

describe("block-style — callout marker conceal migrates -open + badge (caret outside)", () => {
  // Caret OUTSIDE the callout (in the trailing paragraph): the marker StateField
  // conceals the `[!TYPE]` row and publishes its span to the exclusion facet, so
  // buildBlockquoteRule (given that zone) SKIPS line 0 entirely and migrates the
  // rounded -open corner (and thus the top-right badge, which rides `.quoll-callout
  // .quoll-blockquote-open`) onto the first VISIBLE body line.
  it("caret outside: line 0 (marker) is skipped and -open rides the first body line", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const ctxOutside = ctxCaret(doc, doc.indexOf("para") + 1);
    const markerLine = ctxOutside.state.doc.line(1); // `> [!NOTE]`
    const out = lines(
      buildBlockquoteRule(ctxOutside, [{ from: markerLine.from, to: markerLine.to }])
    );
    // No decoration on the concealed marker line.
    expect(out.find((l) => l.from === 0)).toBeUndefined();
    // -open + callout classes ride the first body line (line 2, `> body`).
    const bodyLine = ctxOutside.state.doc.line(2);
    const body = out.find((l) => l.from === bodyLine.from);
    expect(body?.cls).toContain("quoll-blockquote-open");
    expect(body?.cls).toContain("quoll-callout");
    expect(body?.cls).toContain("quoll-callout-note");
    // The marker header class appears NOWHERE (the row is concealed).
    expect(out.every((l) => !l.cls.includes("quoll-callout-marker"))).toBe(true);
  });

  it("caret inside: -open + the marker header class both stay on line 0", () => {
    const doc = "> [!NOTE]\n> body\n\npara";
    const out = lines(buildBlockquoteRule(ctxCaret(doc, 3))); // caret in `[!NOTE]`
    expect(out[0]?.from).toBe(0);
    expect(out[0]?.cls).toContain("quoll-blockquote-open");
    expect(out[0]?.cls).toContain("quoll-callout-marker");
    expect(out[0]?.cls).toContain("quoll-callout-note");
  });

  // R3: the callout body STARTS with a fenced block. Caret outside ⇒ the marker row
  // AND the leading fence are both concealed, so -open must migrate PAST the
  // zero-height fence row onto the fence's first body line.
  it("caret outside, body starts with a fenced block: -open migrates past the concealed fence (R3)", () => {
    // L1 `> [!TIP]` L2 `> ```` L3 `> code` L4 `> ```` then blank + para.
    const doc = "> [!TIP]\n> ```\n> code\n> ```\n\npara";
    const ctxOutside = ctxCaret(doc, doc.indexOf("para") + 1);
    const markerLine = ctxOutside.state.doc.line(1);
    const out = lines(
      buildBlockquoteRule(ctxOutside, [{ from: markerLine.from, to: markerLine.to }])
    );
    // Line 0 skipped (concealed marker); -open lands on the fence BODY line
    // (line 3, `> code`) — past the concealed marker AND the concealed open fence.
    expect(out.find((l) => l.from === 0)).toBeUndefined();
    const codeLine = ctxOutside.state.doc.line(3); // `> code`
    const code = out.find((l) => l.from === codeLine.from);
    expect(code?.cls).toContain("quoll-blockquote-open");
    expect(code?.cls).toContain("quoll-callout-tip");
  });
});

describe("theme.ts — callout admonition per-type rules", () => {
  const spec = blockStyleThemeSpec as Record<string, Record<string, string>>;

  it("the base .quoll-callout rule paints a thin 2px inset accent bar and inherits the blockquote fill", () => {
    const base = spec[".cm-line.quoll-callout"];
    // A 2px inset box-shadow bar (inside the reading column), NOT the 6px
    // alignment border; the fill + alignment are inherited from .quoll-blockquote.
    expect(base?.boxShadow).toBe("inset 2px 0 0 0 var(--quoll-callout-accent)");
    expect(base?.borderLeftColor).toBeUndefined();
    expect(base?.backgroundColor).toBeUndefined();
  });

  it("each type sets its own accent colour + icon custom property", () => {
    for (const [type, accent, icon] of [
      ["note", "editorInfo-foreground", "ℹ️"],
      ["tip", "charts-green", "💡"],
      ["important", "charts-purple", "❗"],
      ["warning", "editorWarning-foreground", "⚠️"],
      ["caution", "editorError-foreground", "🚨"],
    ] as const) {
      const rule = spec[`.cm-line.quoll-callout-${type}`];
      expect(rule?.["--quoll-callout-accent"]).toContain(accent);
      expect(rule?.["--quoll-callout-icon"]).toContain(icon);
    }
  });

  it("a top-right ::after badge consumes the per-type icon (absolutely positioned, on the -open line)", () => {
    // The badge rides `.quoll-callout.quoll-blockquote-open` (the marker row when
    // revealed, the first body line when concealed) so ONE selector covers both
    // states; the old per-marker ::before is gone.
    const badge = spec[".cm-line.quoll-callout.quoll-blockquote-open::after"];
    expect(badge?.content).toContain("var(--quoll-callout-icon");
    expect(badge?.position).toBe("absolute");
    expect(badge?.right).toBeTruthy();
    // The -open line is a positioning context and reserves inline space for the
    // absolutely-positioned badge (so a long title never paints under the emoji).
    const openLine = spec[".cm-line.quoll-callout.quoll-blockquote-open"];
    expect(openLine?.position).toBe("relative");
    expect(openLine?.paddingRight).toBe("calc(var(--quoll-block-pad-x, 16px) + 1.5em)");
    // The old marker ::before rule is GONE; the marker line keeps only the header weight.
    expect(spec[".cm-line.quoll-callout-marker::before"]).toBeUndefined();
    expect(spec[".cm-line.quoll-callout-marker"]?.fontWeight).toBe("600");
    // A concealed marker row collapses to zero height (the 5-prop copy of the
    // fenced-hidden rule).
    const hidden = spec[".cm-line.quoll-callout-marker-hidden"];
    expect(hidden?.height).toBe("0");
    expect(hidden?.minHeight).toBe("0");
    expect(hidden?.paddingTop).toBe("0");
    expect(hidden?.paddingBottom).toBe("0");
    expect(hidden?.lineHeight).toBe("0");
    // The trailing space is dropped from every icon value (the badge supplies its
    // own inline gutter via the reserved right pad).
    for (const type of ["note", "tip", "important", "warning", "caution"] as const) {
      expect(spec[`.cm-line.quoll-callout-${type}`]?.["--quoll-callout-icon"]).not.toMatch(/ "$/);
    }
  });
});
