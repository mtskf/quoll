// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Resolved } from "../../../src/webview/cm/inline/inline-emphasis.js";
import type { CellLeaf } from "../../../src/webview/cm/inline/inline-ir.js";
import { cellPointAt } from "../../../src/webview/cm/table/cell-point.js";
import {
  renderCellInto,
  resetCellRenderLogLatchesForTest,
} from "../../../src/webview/cm/table/cell-render.js";
import type { CellSourceMap } from "../../../src/webview/cm/table/cell-source-map.js";
import {
  getCellSourceMap,
  setCellSourceMap,
} from "../../../src/webview/cm/table/cell-source-map.js";

// Everything in this file is about the arms that exist for a map that CANNOT be
// trusted — a walker that stops tiling its own render, a renderer that throws,
// a map whose numbers are not positions. None of them is reachable through the
// real tokenizer, by construction: that is what makes them defence in depth,
// and also what leaves them unpinned unless the drift they defend against is
// simulated. Two seams do that WITHOUT loosening production code: `parseCellInline`
// is mocked to hand the walker an IR a future (or buggy) tokenizer could hand
// it, and `setCellSourceMap` — the registry's own writer — is used to register
// a map the renderer would never mint. Neither seam is a new trust boundary:
// both already exist for the production path.
const irOverride: { fn: ((raw: string) => Resolved<CellLeaf>[]) | null } = { fn: null };

vi.mock("../../../src/webview/cm/inline/inline-ir.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/webview/cm/inline/inline-ir.js")>();
  return {
    ...actual,
    parseCellInline: (raw: string): Resolved<CellLeaf>[] =>
      irOverride.fn === null ? actual.parseCellInline(raw) : irOverride.fn(raw),
  };
});

let errors: unknown[][] = [];

beforeEach(() => {
  errors = [];
  // Both diagnostics below are warn-once per MODULE (cell-render.ts), which is
  // the behaviour the two "…ONCE per session" rows pin — and which would make
  // every other row here observe nothing after whichever of them ran first.
  resetCellRenderLogLatchesForTest();
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  irOverride.fn = null;
  vi.restoreAllMocks();
});

function renderInto(raw: string): HTMLElement {
  const cell = document.createElement("td");
  renderCellInto(cell, raw);
  return cell;
}

describe("cell-render publishes no map it cannot stand behind", () => {
  // A walker arm that appends rendered text without an `emitRun` (here: an IR
  // text span reaching past what `raw` can supply) leaves the runs describing
  // more characters than the DOM holds. Every later run's index is then wrong,
  // and `sourceOffsetAt` would answer those wrong offsets as EXACT.
  it("drops the runs when they do not tile the rendered text", () => {
    irOverride.fn = () => [{ kind: "text", value: "abc", span: { from: 0, to: 100 } }];
    const cell = renderInto("abc");
    expect(cell.textContent).toBe("abc");
    expect(getCellSourceMap(cell)).toEqual({
      runs: [],
      sourceLength: 3,
      renderedText: "abc",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toContain("does not tile");
    // Lengths only: the cell's bytes must not reach the console.
    expect(errors[0][1]).toEqual({ cursor: 100, renderedLength: 3, sourceLength: 3 });
  });

  // The sibling direction, and the one the comment at the guard actually names:
  // rendered text emitted by a walker arm without an `emitRun` leaves the runs
  // describing FEWER characters than the DOM holds. A reversed second span
  // renders nothing (`raw.slice(2, 0)` is empty) while moving the cursor
  // backwards, which is that shape. Without this row the guard is pinned in one
  // direction only and `cursor <= renderedText.length` passes the whole suite —
  // publishing runs that under-describe the DOM, so every run after the gap
  // answers a wrong-but-exact-LOOKING offset.
  it("drops the runs when they describe FEWER rendered characters than the DOM holds", () => {
    irOverride.fn = () => [
      { kind: "text", value: "ab", span: { from: 0, to: 2 } },
      { kind: "text", value: "", span: { from: 2, to: 0 } },
    ];
    const cell = renderInto("abcd");
    expect(cell.textContent).toBe("ab");
    expect(getCellSourceMap(cell)).toEqual({ runs: [], sourceLength: 4, renderedText: "ab" });
    expect(errors).toHaveLength(1);
    expect(errors[0][1]).toEqual({ cursor: 0, renderedLength: 2, sourceLength: 4 });
  });

  // The `text` arm takes the run's LENGTH from `node.span` and must therefore
  // take the rendered characters from the same span. Trusting `node.value`
  // rests on an unwritten cross-module contract (`value.length === span.to -
  // span.from`) that inline-emphasis.ts maintains BY HAND when it trims a
  // delimiter run.
  it("renders the text arm from the run's own source span, not from node.value", () => {
    irOverride.fn = () => [{ kind: "text", value: "XYZ", span: { from: 0, to: 1 } }];
    const cell = renderInto("abc");
    expect(cell.textContent).toBe("a");
    expect(getCellSourceMap(cell)).toEqual({
      runs: [{ rendered: 0, from: 0, to: 1, outerFrom: 0, outerTo: 1 }],
      sourceLength: 3,
      renderedText: "a",
    });
    // Still tiling, so the map is publishable — the point of taking both halves
    // from one span.
    expect(errors).toEqual([]);
  });

  it("logs the throw it falls back from (adding no field that carries the cell's bytes)", () => {
    irOverride.fn = () => {
      throw new Error("tokenizer exploded");
    };
    const cell = renderInto("**bold**");
    expect(cell.textContent).toBe("**bold**");
    expect(getCellSourceMap(cell)).toEqual({
      runs: [{ rendered: 0, from: 0, to: 8, outerFrom: 0, outerTo: 8 }],
      sourceLength: 8,
      renderedText: "**bold**",
    });
    expect(errors).toHaveLength(1);
    expect(errors[0][0]).toContain("table cell render threw");
    // `toEqual` on the WHOLE payload, and every field a primitive. Logging the
    // Error object itself would defeat both halves of this row: `toMatchObject`
    // would not see a new field, and `JSON.stringify` cannot see an Error's
    // `message`/`stack` at all (non-enumerable), so the leak check below would
    // pass no matter what the payload carried.
    expect(errors[0][1]).toEqual({ errName: "Error", length: 8 });
    // The thrown message is deliberately absent: `assertNever` interpolates the
    // leaf it rejected, so a broken IR type would route a document-derived
    // destination through `err.message` into this payload. `toEqual` on the
    // WHOLE object is what keeps that promise enforceable — a future field
    // carrying the message fails this row rather than slipping past a
    // `toMatchObject`.
    expect(JSON.stringify(errors[0][1])).not.toContain("bold");
    expect(JSON.stringify(errors[0][1])).not.toContain("exploded");
  });

  // The fallback map is the SECOND producer of runs, so it owes the same
  // invariants as `emitRun` — which refuses a zero-length run, because two runs
  // at one rendered index make the boundary lookup ambiguous.
  it("emits no zero-length run when an EMPTY cell falls back", () => {
    irOverride.fn = () => {
      throw new Error("tokenizer exploded");
    };
    const cell = renderInto("");
    expect(getCellSourceMap(cell)).toEqual({ runs: [], sourceLength: 0, renderedText: "" });
  });

  // Both diagnostics sit on `renderCellInto`, which `patchRow` runs for EVERY
  // cell of the table on every content edit — and both conditions are pure
  // functions of the cell's bytes, so an unlatched log repeats per cell per
  // keystroke while the offending bytes stay in the document. The repeats carry
  // no new signal: neither message holds cell identity. (The `beforeEach` reset
  // is what keeps the rows above observing their own log rather than nothing.)
  it("logs the untiled map ONCE per session, not once per re-render", () => {
    irOverride.fn = () => [{ kind: "text", value: "abc", span: { from: 0, to: 100 } }];
    renderInto("abc");
    renderInto("abc");
    expect(errors).toHaveLength(1);
  });

  it("logs the render throw ONCE per session, not once per re-render", () => {
    irOverride.fn = () => {
      throw new Error("tokenizer exploded");
    };
    renderInto("**bold**");
    renderInto("**bold**");
    expect(errors).toHaveLength(1);
  });

  // The two rows above each fire ONE condition, so a single shared latch would
  // satisfy both while silently muting the second failure in production: these
  // are unrelated faults that can co-occur in one session (a walker arm that
  // stops tiling, and a tokenizer that throws on a different cell), and the
  // first to fire must not take the other's only diagnostic with it.
  it("latches the two diagnostics independently (one does not mute the other)", () => {
    irOverride.fn = () => [{ kind: "text", value: "abc", span: { from: 0, to: 100 } }];
    renderInto("abc");
    irOverride.fn = () => {
      throw new Error("tokenizer exploded");
    };
    renderInto("**bold**");
    expect(errors).toHaveLength(2);
    expect(errors[0][0]).toContain("source map");
    expect(errors[1][0]).toContain("table cell render threw");
  });
});

/** A minimal widget root with ONE stamped cell, filled by hand and carrying the
 *  map handed in — the shape `cellPointAt` reads, without a renderer that would
 *  refuse to mint the map under test. */
function stampedCell(text: string, from: number, map: CellSourceMap): HTMLElement {
  const root = document.createElement("div");
  root.className = "quoll-table-block";
  const table = document.createElement("table");
  const tbody = document.createElement("tbody");
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.dataset.cellFrom = String(from);
  td.dataset.cellTo = String(from + map.sourceLength);
  td.appendChild(document.createTextNode(text));
  tr.appendChild(td);
  tbody.appendChild(tr);
  table.appendChild(tbody);
  root.appendChild(table);
  setCellSourceMap(td, map);
  return root;
}

describe("cellPointAt rejects a map offset that is not a position", () => {
  const runs = (from: number, to: number) => [{ rendered: 0, from, to, outerFrom: 0, outerTo: 3 }];

  function offsetFor(map: CellSourceMap): number | null | undefined {
    const root = stampedCell("abc", 40, map);
    const text = root.querySelector("td")?.firstChild as Node;
    return cellPointAt(root, 0, 0, () => ({ node: text, offset: 1 }))?.offset;
  }

  // Control: the same lookup on an integer map IS exact, so the null below can
  // only come from the gate and not from the fixture failing to resolve.
  it("resolves the boundary exactly when the map holds integers", () => {
    expect(offsetFor({ runs: runs(0, 3), sourceLength: 3, renderedText: "abc" })).toBe(41);
  });

  // `Math.min`/`Math.max` propagate a fraction (and a NaN) untouched, so the
  // clamp beside this gate is no defence against one — and `checkSelection`
  // (@codemirror/state) tests only `range.to > doc.length`, so a fractional
  // anchor installs a silently broken selection no try/catch can observe. Same
  // gate `stampedOffset` applies to the DOM stamps, for the same reason.
  it("answers offset:null when the map places the boundary at a fraction", () => {
    expect(offsetFor({ runs: runs(0.5, 2.5), sourceLength: 3, renderedText: "abc" })).toBeNull();
  });
});
