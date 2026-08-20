// @vitest-environment happy-dom
// `updateDOM`: when the widget may reuse an already-rendered DOM (and when it
// must refuse), plus the offset re-stamping both reuse paths owe the click
// handlers. Fresh renders are cm-table-widget-render.test.ts. Fixtures:
// helpers/widget-fixtures.ts.
import { describe, expect, it } from "vitest";

import { parseTable } from "../../../src/markdown/table/index.js";
import { TableBlockWidget } from "../../../src/webview/cm/table/table-widget.js";
import { makeWidget, mockView, stubView } from "./helpers/widget-fixtures.js";

describe("updateDOM", () => {
  // Helper: build a widget, render to DOM, then call updateDOM with a new widget.
  function buildAndUpdate(srcA: string, srcB: string, docFrom = 0) {
    const dispatched: unknown[] = [];
    const view = stubView(dispatched);
    const widgetA = makeWidget(srcA, docFrom);
    const domA = widgetA.toDOM(view);
    const widgetB = makeWidget(srcB, docFrom);
    const result = widgetB.updateDOM(domA, view, widgetA);
    return { dom: domA, result, dispatched, view };
  }

  it("returns false when grid structure changes (different row count)", () => {
    const srcA = "| a | b |\n| - | - |\n| 1 | 2 |";
    const srcB = "| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |";
    const { result } = buildAndUpdate(srcA, srcB);
    expect(result).toBe(false);
  });

  it("returns false when grid structure changes (different col count)", () => {
    const srcA = "| a | b |\n| - | - |\n| 1 | 2 |";
    const srcB = "| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |";
    const { result } = buildAndUpdate(srcA, srcB);
    expect(result).toBe(false);
  });

  // Bug 1 (codex) — updateDOM must validate per-body-row cell counts, not just
  // the header. Revert-check: remove the body-row loop in updateDOM → returns
  // true → red here.
  it("returns false when a body row's cell count changes but the header is unchanged (Bug 1)", () => {
    const srcA = "| a | b |\n| - | - |\n| 1 | 2 |";
    const srcB = "| a | b |\n| - | - |\n| 1 |";
    const { result } = buildAndUpdate(srcA, srcB);
    expect(result).toBe(false);
  });

  // Bug 3 (codex) — patchRow must clear a stale textAlign when a column's
  // alignment is removed. Revert-check: restore the `if (a !== null)` guard →
  // the reused element keeps "center" → red.
  it("clears stale textAlign when a column's alignment is removed (Bug 3)", () => {
    const srcA = "| H |\n| :-: |\n| x |";
    const srcB = "| H |\n| --- |\n| x |";
    const { dom, result } = buildAndUpdate(srcA, srcB);
    expect(result).toBe(true);
    const th = dom.querySelector("thead th") as HTMLElement;
    const td = dom.querySelector("tbody td") as HTMLElement;
    expect(th.style.textAlign).toBe("");
    expect(td.style.textAlign).toBe("");
  });

  it("re-stamps offsets WITHOUT re-tokenizing cells when the slice is unchanged", () => {
    const src = "| a | b |\n| - | - |\n| c | d |\n";
    const a = makeWidget(src, 0);
    const domA = a.toDOM(mockView);
    const th0 = domA.querySelectorAll("thead th")[0] as HTMLElement;
    const cellChild = th0.firstChild; // renderCellInline output node — identity we must preserve
    expect(cellChild).not.toBeNull();

    const table = parseTable(src, 0, src.length);
    if (table === null) {
      throw new Error("fixture must parse");
    }
    const shifted = new TableBlockWidget(table, src, 5, 5); // shifted docFrom + nodeFrom, same bytes
    const reused = shifted.updateDOM(domA, mockView, a);

    expect(reused).toBe(true);
    expect(th0.firstChild).toBe(cellChild); // same node — no textContent="" + re-render
    expect((domA as HTMLElement).dataset.docFrom).toBe("5");
    expect(th0.dataset.cellFrom).toBe("7"); // nodeFrom 5 + 'a' at 2
  });
});

describe("TableBlockWidget cell span stamps", () => {
  it("stamps data-cell-to alongside data-cell-from on a fresh render", () => {
    const src = "| Name | Role |\n| - | - |\n| alpha | admin |";
    const dom = makeWidget(src).toDOM(mockView);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    expect(td.dataset.cellFrom).toBe(String(src.indexOf("alpha")));
    expect(td.dataset.cellTo).toBe(String(src.indexOf("alpha") + "alpha".length));
  });

  it("re-stamps BOTH offsets on a pure positional shift (stampRow path)", () => {
    const src = "| Name | Role |\n| - | - |\n| alpha | admin |";
    const first = new TableBlockWidget(parseTable(src, 0, src.length)!, src, 0, 0);
    const dom = first.toDOM(mockView);
    const shifted = new TableBlockWidget(parseTable(src, 0, src.length)!, src, 5, 5);
    expect(shifted.updateDOM(dom, mockView, first)).toBe(true);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    expect(td.dataset.cellFrom).toBe(String(5 + src.indexOf("alpha")));
    expect(td.dataset.cellTo).toBe(String(5 + src.indexOf("alpha") + "alpha".length));
  });

  it("re-stamps BOTH offsets on a content edit (patchRow path)", () => {
    const src = "| Name | Role |\n| - | - |\n| alpha | admin |";
    const edited = "| Name | Role |\n| - | - |\n| gamma | admin |";
    const first = new TableBlockWidget(parseTable(src, 0, src.length)!, src, 0, 0);
    const dom = first.toDOM(mockView);
    const next = new TableBlockWidget(parseTable(edited, 0, edited.length)!, edited, 0, 0);
    expect(next.updateDOM(dom, mockView, first)).toBe(true);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    expect(td.dataset.cellFrom).toBe(String(edited.indexOf("gamma")));
    expect(td.dataset.cellTo).toBe(String(edited.indexOf("gamma") + "gamma".length));
  });
});
