// @vitest-environment happy-dom
// The source map `renderCellInto` PUBLISHES — one of three files on this map and
// the only one pinning what the renderer puts INTO it. (How the map is read back
// is cm-table-cell-source-map.test.ts, which pins `sourceOffsetAt`; what happens
// when a map cannot be trusted is cm-table-cell-map-failclosed.test.ts.)
// Three depths, in order. First: does the map tile its own render — structural
// invariants that hold for ANY input, so a new construct whose walker arm forgets
// its run fails them without anyone remembering to add a case. Second: WHICH
// source each run claims, which those invariants cannot see — every case there
// would satisfy them while mapping a drag onto the wrong bytes. Third:
// registration, including the identity map a throwing renderer must leave behind
// so a reused cell never describes what it rendered last.
import { describe, expect, it, vi } from "vitest";

import { MAX_INLINE_NESTING_DEPTH } from "../../../src/webview/cm/inline/inline-ir.js";
import { renderCellInto } from "../../../src/webview/cm/table/cell-render.js";
import type {
  CellSourceMap,
  CellSourceRun,
} from "../../../src/webview/cm/table/cell-source-map.js";
import { getCellSourceMap } from "../../../src/webview/cm/table/cell-source-map.js";

// The source map cell-point.ts consumes: every rendered character run paired
// with the source characters it came from, plus the markup its construct owns.
// This block is the AUTOMATIC tripwire that replaced the old
// "renderCellInline never grows the rendered text" describe.
//
// That describe existed because cell-point.ts decided "offsets map 1:1" from
// LENGTH EQUALITY alone, which was only sound while no construct rendered
// longer than its source — an unwritten contract guarded by a hand-maintained
// CASES list, so a construct with no sample could break it silently. The
// invariants below are structural: they hold for ANY input, so a new construct
// whose walker arm forgets its run (or claims the wrong source) fails them
// without anyone remembering to add a case. The corpus is kept only to give
// the tripwire a broad supply of shapes.
describe("cell source map invariants", () => {
  /** Render through the production entry point — `renderCellInto` is what
   *  registers the map, and going through it is what keeps these invariants
   *  pinned to the path the widget actually takes. */
  function mapFor(raw: string, resourceBase = ""): { cell: HTMLElement; map: CellSourceMap } {
    const cell = document.createElement("td");
    renderCellInto(cell, raw, resourceBase);
    const map = getCellSourceMap(cell);
    expect(map, `no map registered for ${JSON.stringify(raw)}`).not.toBeNull();
    return { cell, map: map as CellSourceMap };
  }

  function checkInvariants(raw: string, cell: HTMLElement, map: CellSourceMap): void {
    const where = JSON.stringify(raw);
    // The two halves of cell-point.ts's staleness check must be satisfiable at
    // all: a map whose sourceLength or renderedText disagreed with what it was
    // built from would make EVERY drag on that cell fall back.
    expect(map.sourceLength, where).toBe(raw.length);
    expect(map.renderedText, where).toBe(cell.textContent ?? "");
    let rendered = 0;
    let prevTo = 0;
    let prevOuterTo = 0;
    for (const run of map.runs) {
      // The run's source really is what rendered, character for character —
      // the claim the whole mapping rests on. `rendered` is the running sum of
      // the preceding runs' lengths, which is the map's ONLY notion of a run's
      // rendered position and is how `sourceOffsetAt` derives it too (why no
      // run stores it: the `CellSourceRun` doc in cell-source-map.ts).
      const runLength = run.to - run.from;
      expect(runLength, where).toBeGreaterThan(0);
      expect(raw.slice(run.from, run.to), where).toBe(
        map.renderedText.slice(rendered, rendered + runLength)
      );
      // Source order, non-overlapping: two runs claiming the same byte would
      // make the mapping ambiguous in the other direction.
      expect(run.from, where).toBeGreaterThanOrEqual(prevTo);
      // The outer span contains the run and stays inside the cell...
      expect(run.outerFrom, where).toBeLessThanOrEqual(run.from);
      expect(run.outerTo, where).toBeGreaterThanOrEqual(run.to);
      expect(run.outerFrom, where).toBeGreaterThanOrEqual(prevOuterTo);
      expect(run.outerTo, where).toBeLessThanOrEqual(raw.length);
      rendered += runLength;
      prevTo = run.to;
      prevOuterTo = run.outerTo;
    }
    // ...and together the runs tile the whole rendered text, which is what lets
    // `sourceOffsetAt` treat "not found" as unreachable.
    expect(rendered, where).toBe(map.renderedText.length);
  }

  const CASES = [
    "plain text",
    "**bold**",
    "_em_",
    "~~del~~",
    "==mark==",
    "`code`",
    "[label](https://example.com)",
    "[label](./relative.md)",
    "[label](javascript:alert(1))",
    "<https://example.com>",
    "![alt](https://example.com/x.png)",
    "![alt](./local.png)",
    "\\| escaped pipe",
    "\\*not em\\*",
    "&amp; entity",
    "&lt;&gt;",
    "&#128512;",
    "a &copy; b",
    "***nested bold em***",
    "**[link](https://example.com)**",
    "text with  double  spaces",
    "trailing backslash \\",
    "\u{1f600} emoji",
    "<b>raw html</b>",
    "<!-- comment -->",
    "http://bare.example.com",
  ];
  for (const src of CASES) {
    it(`maps ${JSON.stringify(src)}`, () => {
      const { cell, map } = mapFor(src, "https://base.example/dir/");
      checkInvariants(src, cell, map);
    });
  }

  // The single-construct cases above say nothing about COMPOSITION: a walker
  // arm that leaks a pending opener or a stale skip flag only misbehaves when
  // one construct follows another. Fixed seed so a failure is reproducible
  // from the printed source string alone.
  it("holds for random compositions of every construct", () => {
    const ATOMS = [
      "a",
      " ",
      "**b**",
      "_i_",
      "~~d~~",
      "==m==",
      "`c`",
      "\\|",
      "\\*",
      "&amp;",
      "&#128512;",
      "[l](https://e.test)",
      "![a](./i.png)",
      "<https://e.test>",
      "<b>x</b>",
      "\u{1f600}",
    ];
    // High bits only: this LCG's LOW bits have a very short period, so
    // `seed % n` degenerates (measured: every draw hit the first few atoms, max
    // composition length 8, links and images NEVER generated). `>>> 16` gives a
    // corpus that actually uses all 16 atoms.
    let seed = 1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return (seed >>> 16) % 32768;
    };
    for (let i = 0; i < 500; i++) {
      let src = "";
      for (let n = next() % 6; n > 0; n--) {
        src += ATOMS[next() % ATOMS.length];
      }
      const { cell, map } = mapFor(src, "https://base.example/dir/");
      checkInvariants(src, cell, map);
    }
  });
});

// Which SOURCE a (structurally valid) run claims is invisible to the invariants
// above — every case here would satisfy them while mapping a drag onto the
// wrong bytes. One named case per walker rule.
//
// ⚠ The fixture shapes are verified against the real tokenizer, not guessed.
// A CommonMark closer preceded by PUNCTUATION is right-flanking only when it is
// also followed by whitespace, punctuation or end-of-input — so `**a![i](p)**b`
// (closer preceded by `)`, followed by `b`) forms NO emphasis at all and never
// reaches the wrapper arm. (`**a**b` DOES form emphasis: its closer is preceded
// by an alphanumeric, so what follows is irrelevant.) And every live-image
// fixture uses an ABSOLUTE `https:` src because `resolveAgainstBase` returns
// null for a relative src with an empty base, which renders the image INERT —
// a run-emitting path that would silently test the wrong arm. Do not
// paraphrase them.
describe("cell source map — walker rules", () => {
  const IMG = "![i](https://x.test/a.png)";

  function runsOf(raw: string, resourceBase = ""): readonly CellSourceRun[] {
    const cell = document.createElement("td");
    renderCellInto(cell, raw, resourceBase);
    return (getCellSourceMap(cell) as CellSourceMap).runs;
  }

  // Rule 1 (set-if-empty): an already-pending OUTER opener wins. Overwriting
  // would orphan the outer delimiters, and a selection of `x` would no longer
  // round-trip to the same rendered content.
  it.each([
    ["***x***"],
    ["**_b_**"],
  ])("attributes BOTH delimiter pairs of %s to its single run", (src) => {
    expect(runsOf(src)).toEqual([{ from: 3, to: 4, outerFrom: 0, outerTo: 7 }]);
  });

  // Rule 4: a wrapper whose text is followed by an invisible construct must NOT
  // extend its closers over it — that would swallow the image into the left
  // run and make a boundary straddling it look exact.
  it("does not extend outerTo over trailing skipped source", () => {
    expect(runsOf(`**a${IMG}**`)).toEqual([{ from: 2, to: 3, outerFrom: 0, outerTo: 3 }]);
  });

  // Rule 5: a wrapper that rendered nothing must not lend its delimiters to a
  // later, unrelated run — the " a" run keeps its OWN outerFrom.
  it("does not attribute an empty wrapper's delimiters to the next run", () => {
    const src = `*${IMG}* a`;
    expect(runsOf(src)).toEqual([
      {
        from: src.length - 2,
        to: src.length,
        outerFrom: src.length - 2,
        outerTo: src.length,
      },
    ]);
  });

  // Zero-length guard: a live link with an empty label renders `<a></a>`. Two
  // runs at the same rendered index would make the boundary lookup ambiguous,
  // so it emits none — and records the skip, which the following run's own
  // outerFrom is what proves.
  it("emits no run for a zero-length live link, and marks the skip", () => {
    const empty = "[](https://example.com)";
    expect(runsOf(empty)).toEqual([]);
    expect(runsOf(`${empty}a`)).toEqual([
      {
        from: empty.length,
        to: empty.length + 1,
        outerFrom: empty.length,
        outerTo: empty.length + 1,
      },
    ]);
  });

  it("emits a whole-span run for an inert link (its source renders verbatim)", () => {
    const inert = "[bad](javascript:1)";
    expect(runsOf(inert)).toEqual([
      { from: 0, to: inert.length, outerFrom: 0, outerTo: inert.length },
    ]);
  });

  // Past MAX_INLINE_NESTING_DEPTH the walker stops recursing and renders the
  // literal source, so the run it emits is the whole span — same arm as an
  // inert construct. Without its own emitRun the deep span would render text
  // no run described, and every boundary after it would be off.
  it("emits a whole-span run for the past-depth-cap emphasis literal", () => {
    // Two delimiters per nesting level (each `**` pair is one <strong>), so
    // 2 × (cap + 1) is what actually reaches depth 100 — a bare cap + 1 stops
    // at ~51 levels and never fires the arm. The literal that survives is the
    // innermost `**x**`, rendered VERBATIM, which is why it needs a run of its
    // own: without one it would emit text no run described and every later
    // boundary would be off by its length.
    const pad = "*".repeat(2 * (MAX_INLINE_NESTING_DEPTH + 1));
    const src = `${pad}x${pad}`;
    const literal = "**x**";
    const from = pad.length - 2;
    expect(runsOf(src)).toEqual([
      {
        from,
        to: from + literal.length,
        // The outer wrappers each rendered text, so their closers accumulate
        // outward all the way to the end of the cell.
        outerFrom: 0,
        outerTo: src.length,
      },
    ]);
    expect(src.slice(from, from + literal.length)).toBe(literal);
  });
});

describe("renderCellInto", () => {
  it("registers a map whose renderedText is the cell's own textContent", () => {
    const cell = document.createElement("td");
    renderCellInto(cell, "**bold**");
    expect(cell.innerHTML).toBe("<strong>bold</strong>");
    expect(getCellSourceMap(cell)?.renderedText).toBe(cell.textContent);
  });

  it("replaces the previous map on re-render (a reused patchRow cell)", () => {
    const cell = document.createElement("td");
    renderCellInto(cell, "**bold**");
    renderCellInto(cell, "hi");
    expect(cell.textContent).toBe("hi");
    expect(getCellSourceMap(cell)).toEqual({
      runs: [{ from: 0, to: 2, outerFrom: 0, outerTo: 2 }],
      sourceLength: 2,
      renderedText: "hi",
    });
  });

  // Defense in depth: an unforeseen throw falls back to inert source text, and
  // the map must fall back WITH it. Registering nothing would leave a reused
  // cell describing whatever it rendered last — a stale map that passes the
  // length half of the staleness check whenever the two sources are the same
  // length.
  it("registers the identity map when the renderer throws", () => {
    const cell = document.createElement("td");
    // The fallback logs BY DESIGN (cell-render.ts's catch), so silence it here
    // rather than leave a maintainer wondering whether the line is a symptom.
    // It is asserted where it is the subject: cm-table-cell-map-failclosed.ts.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(document, "createElement").mockImplementation(() => {
      throw new Error("renderer exploded");
    });
    try {
      renderCellInto(cell, "**bold**");
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
    expect(cell.textContent).toBe("**bold**");
    expect(getCellSourceMap(cell)).toEqual({
      runs: [{ from: 0, to: 8, outerFrom: 0, outerTo: 8 }],
      sourceLength: 8,
      renderedText: "**bold**",
    });
  });
});
