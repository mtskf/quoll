// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Resolved } from "../../../src/webview/cm/inline/inline-emphasis.js";
import type { CellLeaf } from "../../../src/webview/cm/inline/inline-ir.js";
import { cellPointAt } from "../../../src/webview/cm/table/cell-point.js";
import { renderCellInto } from "../../../src/webview/cm/table/cell-render.js";
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

  it("logs the throw it falls back from (never the cell's bytes)", () => {
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
    expect(errors[0][1]).toMatchObject({ length: 8 });
    expect(String((errors[0][1] as { err: unknown }).err)).toContain("tokenizer exploded");
    // The raw source is not in the diagnostic.
    expect(JSON.stringify(errors[0][1])).not.toContain("bold");
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
