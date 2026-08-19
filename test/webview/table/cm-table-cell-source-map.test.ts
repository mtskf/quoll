// @vitest-environment happy-dom
//
// `sourceOffsetAt` — the boundary lookup that turns a rendered offset inside a
// table cell into a source offset — pinned DIRECTLY, at every arm.
//
// Why its own file: until now the function had no importer in the suite at all.
// Everything reached it through `cellPointAt`, whose fixtures only ever build
// the INTERIOR-junction shape, so each of its three refusal arms (leading
// skipped source, trailing skipped source, a cell that renders nothing from
// something) could be mutated into returning a real offset with the whole suite
// still green — a mutant that claims an EXACT drag mapping across an invisible
// image, which is precisely the answer the arm exists to refuse.
//
// Every map here is built by the production renderer (`renderCellInto` →
// `getCellSourceMap`) rather than written by hand: a hand-built map would pin
// the lookup against a shape the renderer may never emit, and the renderer is
// the mapping authority (cell-render.ts). The live-image fixture's `https:` src
// is load-bearing — a RELATIVE src with an empty resource base resolves to null
// and renders the image INERT, whose whole source slice DOES emit a run, which
// would quietly make every case below mappable and vacuous.
import { describe, expect, it } from "vitest";

import { renderCellInto } from "../../../src/webview/cm/table/cell-render.js";
import {
  asCellSourceOffset,
  asRenderedOffset,
  type CellSourceMap,
  type CellSourceOffset,
  getCellSourceMap,
  sourceOffsetAt,
} from "../../../src/webview/cm/table/cell-source-map.js";

const IMG = "![i](https://x.test/a.png)";

function mapOf(raw: string): CellSourceMap {
  const cell = document.createElement("td");
  renderCellInto(cell, raw);
  const map = getCellSourceMap(cell);
  expect(map, `no map registered for ${JSON.stringify(raw)}`).not.toBeNull();
  return map as CellSourceMap;
}

/** Every rendered boundary of a cell, answered in order — `renderedText.length
 *  + 1` of them, because a boundary sits BETWEEN characters. Asserting the
 *  whole vector rather than one probe is what makes a mutant visible wherever
 *  it lands: an arm that starts answering an offset shows up as a changed
 *  entry even if the case was written for a different arm. */
function boundaries(raw: string): Array<number | null> {
  const map = mapOf(raw);
  return Array.from({ length: map.renderedText.length + 1 }, (_, within) =>
    sourceOffsetAt(map, asRenderedOffset(within))
  );
}

describe("sourceOffsetAt", () => {
  // The control. Without it every expectation below is satisfiable by a
  // `return null` body, and the three refusal arms would be pinned by a
  // function that refuses everything.
  it("answers every boundary of a cell with no invisible construct", () => {
    expect(boundaries("abc")).toEqual([0, 1, 2, 3]);
    // Rendered `bold` is source `**bold**`: the interior boundaries land
    // BETWEEN the delimiters, the two edges expand OVER them (`outerFrom` /
    // `outerTo`) so a full-content selection still round-trips to the same
    // render.
    expect(boundaries("**bold**")).toEqual([0, 3, 4, 5, 8]);
  });

  // Refusal arm 1 — leading skipped source. The first run's openers start
  // AFTER the cell start (`run.outerFrom !== 0`), so boundary 0 is on neither
  // side of the image in particular: a rendered offset cannot prove the pointer
  // crossed a construct that renders zero characters. The two mutants answer
  // DIFFERENT wrong offsets, and which one you get is exactly what this arm
  // settles — where the first run's openers actually start:
  // `return run.outerFrom` answers 26 — just past the image, since `emitRun`
  // gives a run following skipped source `outerFrom: from` — while dropping the
  // check answers 0, the cell start. Either is an exact-looking mapping for a
  // pointer that may have been on the other side of the image.
  it("refuses the boundary before leading skipped source", () => {
    expect(boundaries(`${IMG}a`)).toEqual([null, IMG.length + 1]);
  });

  // Refusal arm 2 — trailing skipped source. The last run's closers stop short
  // of the source end, so the end-of-text boundary could be either side of the
  // image. Mutating it to always answer `sourceLength` would place a drag that
  // ended BEFORE the image at the end of the cell.
  it("refuses the end-of-text boundary after trailing skipped source", () => {
    expect(boundaries(`a${IMG}`)).toEqual([0, null]);
  });

  // Refusal arm 3 — a cell that renders NOTHING out of something. No run at
  // all, and its single boundary sits on both sides of the image at once. The
  // `sourceLength === 0` half of the guard is what distinguishes it from a
  // genuinely EMPTY cell, whose only boundary really is source offset 0.
  it("refuses the only boundary of a cell whose whole source renders invisibly", () => {
    expect(boundaries(IMG)).toEqual([null]);
    expect(boundaries("")).toEqual([0]);
  });

  // The interior arithmetic (`run.from + (within - rendered)`, where `rendered`
  // is the running sum of the preceding runs' lengths) for a run
  // that is NOT the first one. Every other fixture in THIS file leaves that
  // case unobserved: the multi-run cells (`a${IMG}b`, `a\\|b`) have runs ONE
  // character wide, and no integer sits strictly between two consecutive
  // integers, so their later runs only ever reach the junction and end-of-text
  // arms. Elsewhere the case is reached only INDIRECTLY — measured: a mutant
  // reading `runs[0]` where the loop means `run` also reds
  // cm-table-cell-point.test.ts's mixed-children row, which arrives through
  // `cellPointAt`'s DOM walk over a cell holding a code span. That is a real
  // pin but an oblique one: it fails while naming a DOM traversal, and it
  // would go away with a fixture change made for reasons having nothing to do
  // with this arm. This row states the same contract where the arm lives.
  it("resolves an interior boundary inside a run that is not the cell's first", () => {
    // Rendered `abc` is source `**a**bc`: run 0 is the `a` inside the
    // delimiters, run 1 the plain `bc`. Boundary 2 sits strictly inside run 1
    // (source 6); boundary 1 is the junction and 3 the end of the text.
    expect(boundaries("**a**bc")).toEqual([0, 5, 6, 7]);
  });

  // The interior junction — the one shape `cellPointAt`'s fixtures already
  // reach, kept here so the three arms above are read against the case they
  // are the edges of.
  it("refuses an interior junction across an invisible construct", () => {
    expect(boundaries(`a${IMG}b`)).toEqual([0, null, IMG.length + 2]);
  });

  // An escape's `\` is an OPENER: the run for the escaped character must own
  // it, or the junction between `a` and `|` stops matching the previous run's
  // `outerTo` and answers null. The only other escape fixture in the suite
  // (`\|` as a whole cell) never reads `outerFrom` — it exits through the
  // end-of-text arm — so deleting `ctx.pendingOpen ??= node.span.from` from
  // cell-render.ts's escape arm leaves that one green. This one goes red.
  it("keeps an escape's backslash with the character it produces", () => {
    // Source `a\|b` renders `a|b`; boundary 1 is the junction between the `a`
    // run (`outerTo` 1) and the escape's run, whose openers must reach back to
    // the backslash at 1 for the two to coincide.
    expect(boundaries("a\\|b")).toEqual([0, 1, 3, 4]);
  });

  // Input gate. `within` arrives from a DOM measurement one layer up
  // (cell-point.ts), so out-of-range and non-integer inputs are answered
  // rather than indexed with.
  it("refuses a boundary outside the rendered text, or a non-integer one", () => {
    const map = mapOf("abc");
    expect(sourceOffsetAt(map, asRenderedOffset(-1))).toBeNull();
    expect(sourceOffsetAt(map, asRenderedOffset(4))).toBeNull();
    expect(sourceOffsetAt(map, asRenderedOffset(1.5))).toBeNull();
    expect(sourceOffsetAt(map, asRenderedOffset(Number.NaN))).toBeNull();
  });
});

// The offset spaces are branded, so the confusion this module's header warns
// about ("a DOM character offset is NOT addable to the cell's source offset")
// is a COMPILE error rather than a comment. These rows are type-level:
// `pnpm compile` type-checks test/webview (test/webview/tsconfig.json), so an
// unneeded `@ts-expect-error` here is TS2578 — which is what makes them
// non-vacuous. ONE PIN PER BRAND, because one mutation reds exactly one pin:
// with fewer, dropping a brand leaves the other pin still erroring, so it never
// reports TS2578 and the proof silently fails to cover that brand (measured).
// Each directive applies to the ONE statement after it.
describe("offset space brands", () => {
  it("refuses a cell-source offset where a rendered offset is required", () => {
    const map = mapOf("abc");
    // @ts-expect-error — `within` is a RENDERED index; a cell-source offset is
    // a different space even though both are numbers at runtime.
    const answer = sourceOffsetAt(map, asCellSourceOffset(1));
    // The runtime answer is unremarkable (brands are erased); the assertion is
    // here so the row is a real test rather than a bare directive.
    expect(answer).toBe(1);
  });

  it("refuses a rendered offset where a cell-source offset is required", () => {
    // @ts-expect-error — the reverse direction, which the pin above cannot
    // cover: dropping the CellSourceOffset brand reds only this one.
    const wrong: CellSourceOffset = asRenderedOffset(1);
    expect(wrong).toBe(1);
  });
});
