// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, type EditorView as EditorViewType, WidgetType } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseTable } from "../../../src/markdown/table/index.js";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol.js";
import { quollResourceBaseUri } from "../../../src/webview/cm/image/resource-base.js";
import {
  openExternalSinkFor,
  quollOpenExternalSink,
} from "../../../src/webview/cm/open-external.js";
import {
  type CaretResolver,
  quollTableCaretResolver,
} from "../../../src/webview/cm/table/cell-point.js";
import { TableBlockWidget } from "../../../src/webview/cm/table/table-widget.js";

function makeWidget(src: string, docFrom = 0): TableBlockWidget {
  const table = parseTable(src, 0, src.length);
  if (table === null) {
    throw new Error("fixture must parse");
  }
  return new TableBlockWidget(table, src, docFrom, 0);
}

/** Minimal view stub — display-only toDOM reads `view.dispatch` and
 *  `view.state.facet(quollResourceBaseUri)` (a real EditorState so facet
 *  reads work; no doc/extensions beyond the optional resource base). */
function stubView(
  dispatched?: unknown[],
  resourceBase?: string,
  opened?: string[]
): EditorViewType {
  const extensions = [];
  if (resourceBase !== undefined) {
    extensions.push(quollResourceBaseUri.of(resourceBase));
  }
  if (opened !== undefined) {
    extensions.push(quollOpenExternalSink.of((href: string) => opened.push(href)));
  }
  return {
    state: EditorState.create({ extensions }),
    dispatch: (tr: unknown) => dispatched?.push(tr),
  } as unknown as EditorViewType;
}

const mockView = stubView();

// Widgets under test are mounted into the body (the caret resolver needs a live
// tree). Clear it between tests so no test can see an earlier test's widget —
// a mechanism, rather than each test remembering to tidy up.
afterEach(() => {
  document.body.replaceChildren();
});

describe("TableBlockWidget.toDOM", () => {
  it("renders a wrapper <div> containing <table> with <thead>, <tbody>, and one <tr> per row", () => {
    const src = "| H1 | H2 |\n| -- | -- |\n| a1 | a2 |\n| b1 | b2 |";
    const dom = makeWidget(src).toDOM(mockView);
    // Widget root is a <div> wrapper (NOT <table>) — see table-widget.ts
    // for rationale (margin→padding to align CM measure with click target).
    expect(dom.tagName).toBe("DIV");
    expect(dom.classList.contains("quoll-table-block")).toBe(true);
    // Block-widget marker (CL slice): the `quoll-block` class is the hook
    // for the `margin: 0` measurement invariant (styles.css, widget
    // layer). Pinned here so a future refactor that drops the marker fails
    // loudly instead of silently regressing click→caret accuracy.
    expect(dom.classList.contains("quoll-block")).toBe(true);
    expect(dom.querySelector("table")).not.toBeNull();
    const thead = dom.querySelector("thead");
    const tbody = dom.querySelector("tbody");
    expect(thead).not.toBeNull();
    expect(tbody).not.toBeNull();
    expect(thead?.querySelectorAll("tr").length).toBe(1);
    expect(thead?.querySelectorAll("th").length).toBe(2);
    expect(tbody?.querySelectorAll("tr").length).toBe(2);
    expect(tbody?.querySelectorAll("td").length).toBe(4);
  });

  it("writes header cell text into <th>", () => {
    const src = "| Name | Role |\n| - | - |\n| a | b |";
    const dom = makeWidget(src).toDOM(mockView);
    const ths = dom.querySelectorAll("th");
    expect(ths[0].textContent).toBe("Name");
    expect(ths[1].textContent).toBe("Role");
  });

  it("applies per-column text-align from delimiter alignment", () => {
    const src = "| L | C | R |\n| :- | :-: | -: |\n| 1 | 2 | 3 |";
    const dom = makeWidget(src).toDOM(mockView);
    const ths = dom.querySelectorAll("th");
    expect(ths[0].style.textAlign).toBe("left");
    expect(ths[1].style.textAlign).toBe("center");
    expect(ths[2].style.textAlign).toBe("right");
    const tds = dom.querySelectorAll<HTMLElement>("tbody td");
    expect(tds[0].style.textAlign).toBe("left");
    expect(tds[1].style.textAlign).toBe("center");
    expect(tds[2].style.textAlign).toBe("right");
  });

  it("omits text-align for default-aligned columns", () => {
    const src = "| A | B |\n| - | - |\n| 1 | 2 |";
    const dom = makeWidget(src).toDOM(mockView);
    const ths = dom.querySelectorAll("th");
    expect(ths[0].style.textAlign).toBe("");
    expect(ths[1].style.textAlign).toBe("");
  });

  it("routes safe in-cell URLs through renderCellInline (live <a href>)", () => {
    const src = "| Link |\n| - |\n| [docs](https://example.com) |";
    const dom = makeWidget(src).toDOM(mockView);
    const a = dom.querySelector("tbody a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("https://example.com");
    expect(a?.textContent).toBe("docs");
  });

  it("keeps in-cell links tabbable (no tabindex=-1 on <a>)", () => {
    // Contract pin: renderCellInline must never set tabindex=-1 on anchors.
    const src = "| [home](https://example.com) | b |\n| - | - |\n| c | d |";
    const dom = makeWidget(src).toDOM(mockView);
    const anchors = dom.querySelectorAll("a");
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute("tabindex")).not.toBe("-1");
    }
  });

  it("renders an unsafe in-cell URL as inert text (no <a>, no <img>)", () => {
    const src = "| Link |\n| - |\n| [x](javascript:alert(1)) |";
    const dom = makeWidget(src).toDOM(mockView);
    expect(dom.querySelector("tbody a")).toBeNull();
    expect(dom.querySelector("tbody img")).toBeNull();
    expect(dom.querySelector("tbody td")?.textContent).toBe("[x](javascript:alert(1))");
  });

  it("renders `**bold**` / `*em*` cell content as live <strong> / <em> (widget-level C6b scope)", () => {
    const src = "| **bold** |\n| - |\n| *em* |";
    const dom = makeWidget(src).toDOM(mockView);
    const headerStrong = dom.querySelector("thead th strong");
    const bodyEm = dom.querySelector("tbody td em");
    expect(headerStrong).not.toBeNull();
    expect(headerStrong?.textContent).toBe("bold");
    expect(bodyEm).not.toBeNull();
    expect(bodyEm?.textContent).toBe("em");
    expect(dom.querySelector("thead th")?.textContent).toBe("bold");
    expect(dom.querySelector("tbody td")?.textContent).toBe("em");
  });

  it("renders `_em_` cell content as a live <em> (C6c-prereq delimiter-stack)", () => {
    const src = "| _em_ |\n| - |\n| plain |";
    const dom = makeWidget(src).toDOM(mockView);
    const headerEm = dom.querySelector("thead th em");
    expect(headerEm).not.toBeNull();
    expect(headerEm?.textContent).toBe("em");
    expect(dom.querySelector("thead th")?.textContent).toBe("em");
  });

  it("marks header cells with scope=col (native column-header association)", () => {
    const src = "| A | B |\n| - | - |\n| 1 | 2 |";
    const dom = makeWidget(src).toDOM(mockView);
    const ths = dom.querySelectorAll("thead th");
    expect(ths.length).toBe(2);
    for (const th of ths) {
      expect(th.getAttribute("scope")).toBe("col");
    }
    for (const td of dom.querySelectorAll("tbody td")) {
      expect(td.getAttribute("scope")).toBeNull();
    }
  });

  it("ignoreEvent() returns true so CodeMirror does not synthesise state updates from widget DOM", () => {
    const src = "| A |\n| - |\n| 1 |";
    expect(makeWidget(src).ignoreEvent()).toBe(true);
  });

  it("eq() is true for the same (docFrom, slice) and false when slice differs", () => {
    const src = "| A |\n| - |\n| 1 |";
    const a = makeWidget(src, 100);
    const parsed = parseTable(src, 0, src.length);
    if (parsed === null) {
      throw new Error("fixture must parse");
    }
    const b = new TableBlockWidget(parsed, src, 100, 0);
    expect(a.eq(b)).toBe(true);
    const otherSrc = "| A |\n| - |\n| 2 |";
    const parsedOther = parseTable(otherSrc, 0, otherSrc.length);
    if (parsedOther === null) {
      throw new Error("fixture must parse");
    }
    const c = new TableBlockWidget(parsedOther, otherSrc, 100, 0);
    expect(a.eq(c)).toBe(false);
  });

  // The `other instanceof TableBlockWidget` short-circuit is a defensive
  // invariant: CM6's RangeSet eq() pipeline can call eq() across
  // heterogeneous widget types when block widgets share the same range.
  it("eq() returns false when other is a different WidgetType subclass (instanceof guard)", () => {
    class OtherWidget extends WidgetType {
      toDOM(): HTMLElement {
        return document.createElement("span");
      }
    }
    const a = makeWidget("| A |\n| - |\n| 1 |", 0);
    expect(a.eq(new OtherWidget())).toBe(false);
  });

  it("eq() is reflexive for the same instance", () => {
    const a = makeWidget("| A |\n| - |\n| 1 |", 0);
    expect(a.eq(a)).toBe(true);
  });

  // Codex re-review Conf 82 — two byte-identical tables at different doc
  // positions must NOT eq, or CM reuses the wrong DOM.
  it("eq() is false for the same slice at different docFrom positions", () => {
    const src = "| A |\n| - |\n| 1 |";
    const a = makeWidget(src, 0);
    const b = makeWidget(src, 100);
    expect(a.eq(b)).toBe(false);
  });

  it("renders a row whose cell count differs from the header (no padding, no truncation)", () => {
    const src = "| A | B |\n| - | - |\n| only-one |";
    const dom = makeWidget(src).toDOM(mockView);
    const tds = dom.querySelectorAll("tbody td");
    expect(tds.length).toBe(1);
    expect(tds[0].textContent).toBe("only-one");
  });

  it("renders a header-only table (zero body rows) with an empty <tbody>", () => {
    const src = "| H |\n| - |";
    const dom = makeWidget(src).toDOM(mockView);
    expect(dom.querySelector("thead tr th")?.textContent).toBe("H");
    const tbody = dom.querySelector("tbody");
    expect(tbody).not.toBeNull();
    expect(tbody?.querySelectorAll("tr").length).toBe(0);
  });

  it("stamps each cell with its absolute LF-internal source offset (data-cell-from)", () => {
    const src = "| a | b |\n| - | - |\n| c | d |";
    const table = parseTable(src, 0, src.length);
    if (!table) {
      throw new Error("fixture parse failed");
    }
    const dom = new TableBlockWidget(table, src, 0, 0).toDOM(mockView);
    const head = dom.querySelectorAll("thead th");
    expect((head[0] as HTMLElement).dataset.cellFrom).toBe("2"); // 'a' at "| a"→2
    expect((head[1] as HTMLElement).dataset.cellFrom).toBe("6"); // 'b' at "| a | b"→6
    expect((dom as HTMLElement).dataset.docFrom).toBe("0"); // dom IS the .quoll-table-block root
  });

  it("click on a cell dispatches a caret at that cell's source offset", () => {
    const src = "| a | b |\n| - | - |\n| c | d |";
    const table = parseTable(src, 0, src.length);
    if (!table) {
      throw new Error("fixture parse failed");
    }
    const dispatched: unknown[] = [];
    const stub = stubView(dispatched);
    const dom = new TableBlockWidget(table, src, 0, 0).toDOM(stub);
    const bodyCells = dom.querySelectorAll("tbody td");
    const expected = Number((bodyCells[1] as HTMLElement).dataset.cellFrom); // 'd'
    (bodyCells[1] as HTMLElement).click();
    expect(dispatched).toEqual([{ selection: { anchor: expected } }]);
  });

  it("click on the widget margin (no cell) falls back to the block start", () => {
    const src = "| a |\n| - |";
    const table = parseTable(src, 0, src.length);
    if (!table) {
      throw new Error("fixture parse failed");
    }
    const dispatched: unknown[] = [];
    const stub = stubView(dispatched);
    const dom = new TableBlockWidget(table, src, 7, 7).toDOM(stub);
    dom.click(); // the root div, not a cell
    expect(dispatched).toEqual([{ selection: { anchor: 7 } }]);
  });

  it("keeps docFrom (margin) and nodeFrom (cell base) independent when they differ", () => {
    // Non-line-aligned edge: block starts at docFrom=0 but the Lezer node at 2.
    const src = "| a |\n| - |";
    const table = parseTable(src, 0, src.length);
    if (!table) {
      throw new Error("fixture parse failed");
    }
    const dispatched: unknown[] = [];
    const stub = stubView(dispatched);
    const dom = new TableBlockWidget(table, src, 0, 2).toDOM(stub); // docFrom=0, nodeFrom=2
    const th = dom.querySelector("thead th") as HTMLElement;
    expect(th.dataset.cellFrom).toBe("4"); // nodeFrom 2 + 'a' at 2
    dom.click(); // margin → docFrom, NOT nodeFrom
    expect(dispatched).toEqual([{ selection: { anchor: 0 } }]);
  });

  it("re-stamps offsets on updateDOM so a click after a shift uses the new base", () => {
    // A distant insertion shifts the table (new docFrom/nodeFrom) but its bytes
    // (slice) are unchanged → eq() false → updateDOM reuses the DOM in place.
    const src = "| a |\n| - |";
    const table = parseTable(src, 0, src.length);
    if (!table) {
      throw new Error("fixture parse failed");
    }
    const dispatched: unknown[] = [];
    const stub = stubView(dispatched);
    const original = new TableBlockWidget(table, src, 0, 0);
    const dom = original.toDOM(stub);
    const reused = new TableBlockWidget(table, src, 5, 5).updateDOM(
      dom,
      stub as EditorViewType,
      original
    );
    expect(reused).toBe(true);
    dom.click(); // margin fallback now points at the NEW docFrom
    expect(dispatched).toEqual([{ selection: { anchor: 5 } }]);
    const th = dom.querySelector("thead th") as HTMLElement;
    expect(th.dataset.cellFrom).toBe("7"); // NEW nodeFrom 5 + 'a' at 2
  });

  it("click on the widget dispatches a selection to docFrom (click → reveal trigger)", () => {
    const src = "| A |\n| - |\n| 1 |";
    const dispatched: unknown[] = [];
    const stub = stubView(dispatched);
    const dom = makeWidget(src, 42).toDOM(stub);
    dom.click();
    expect(dispatched).toEqual([{ selection: { anchor: 42 } }]);
  });

  // C6b smoke #5 follow-up — plain click on a widget-internal link must NOT
  // navigate the browser. cell-render's `<a>` listener swallows the default,
  // and the bubbled click then triggers the widget's caret-dispatch path so
  // reveal-on-caret fires and the user can edit the link source.
  it("plain click on an <a> inside the widget DISPATCHES caret to the containing cell offset (reveal-on-caret takes over)", () => {
    const src = "| Link |\n| - |\n| [docs](https://example.com) |";
    const dispatched: Array<{ selection?: { anchor: number } }> = [];
    const stub = stubView(dispatched as unknown[]);
    const dom = makeWidget(src, 17).toDOM(stub);
    const a = dom.querySelector("a");
    expect(a).not.toBeNull();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    a?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // The dispatch lands at the containing cell's data-cell-from offset.
    const td = a?.closest("td") as HTMLElement | null;
    const expected = Number(td?.dataset.cellFrom);
    const sel = dispatched.find((tr) => tr.selection)?.selection;
    expect(sel).toEqual({ anchor: expected });
  });

  it("Cmd/Ctrl-click on an absolute https <a> routes through the sink (no caret dispatch)", () => {
    const src = "| Link |\n| - |\n| [docs](https://example.com) |";
    const dispatched: unknown[] = [];
    const opened: string[] = [];
    const stub = stubView(dispatched, undefined, opened);
    const dom = makeWidget(src).toDOM(stub);
    const a = dom.querySelector("a");
    expect(a).not.toBeNull();
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      opened.length = 0;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true); // native nav suppressed
      expect(opened).toEqual(["https://example.com"]); // routed through the host gate
    }
    expect(dispatched).toEqual([]);
  });

  it("Cmd/Ctrl-click on an absolute mailto <a> routes through the sink", () => {
    const src = "| Link |\n| - |\n| [mail](mailto:a@b.test) |";
    const dispatched: unknown[] = [];
    const opened: string[] = [];
    const stub = stubView(dispatched, undefined, opened);
    const dom = makeWidget(src).toDOM(stub);
    const a = dom.querySelector("a");
    expect(a?.getAttribute("href")).toBe("mailto:a@b.test");
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    a?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual(["mailto:a@b.test"]);
    expect(dispatched).toEqual([]);
  });

  // Dead-click regression pin. cell-render preventDefault's modifier-click on
  // relative / fragment hrefs, so the widget root MUST fall through to caret
  // dispatch — otherwise the user gets nothing.
  it("Cmd/Ctrl-click on a relative-URL <a> DISPATCHES caret to the containing cell offset (defaultPrevented → fall through)", () => {
    const src = "| Link |\n| - |\n| [doc](./readme.md) |";
    const dispatched: Array<{ selection?: { anchor: number } }> = [];
    const stub = stubView(dispatched as unknown[]);
    const dom = makeWidget(src, 23).toDOM(stub);
    const a = dom.querySelector("a");
    expect(a).not.toBeNull();
    expect(a?.getAttribute("href")).toBe("./readme.md");
    const td = a?.closest("td") as HTMLElement | null;
    const expected = Number(td?.dataset.cellFrom);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      dispatched.length = 0;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      a?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      const sel = dispatched.find((tr) => tr.selection)?.selection;
      expect(sel).toEqual({ anchor: expected });
    }
  });

  // Widget-level pin parallel to the inline-link Cmd/Ctrl test above.
  it("Cmd/Ctrl-click on a CHILD element inside an autolink <a> routes through the sink (closest('a'))", () => {
    const src = "| Link |\n| - |\n| <https://example.com> |";
    const dispatched: unknown[] = [];
    const opened: string[] = [];
    const stub = stubView(dispatched, undefined, opened);
    const dom = makeWidget(src).toDOM(stub);
    const a = dom.querySelector("a");
    if (a === null) {
      throw new Error("anchor must exist");
    }
    expect(a.getAttribute("href")).toBe("https://example.com");
    const child = document.createElement("span");
    child.textContent = a.textContent ?? "";
    a.textContent = "";
    a.appendChild(child);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      opened.length = 0;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      child.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(opened).toEqual(["https://example.com"]);
    }
    expect(dispatched).toEqual([]);
  });

  // Descendant-safe modifier-click guard.
  it("Cmd/Ctrl-click on a CHILD element inside <a> routes through the sink (closest('a') guard)", () => {
    const src = "| Link |\n| - |\n| [docs](https://example.com) |";
    const dispatched: unknown[] = [];
    const opened: string[] = [];
    const stub = stubView(dispatched, undefined, opened);
    const dom = makeWidget(src).toDOM(stub);
    const a = dom.querySelector("a");
    if (a === null) {
      throw new Error("anchor must exist");
    }
    const child = document.createElement("span");
    child.textContent = "docs";
    a.textContent = "";
    a.appendChild(child);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      opened.length = 0;
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...modifier });
      child.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(opened).toEqual(["https://example.com"]);
    }
    expect(dispatched).toEqual([]);
  });

  it("integration: a mounted view wired with openExternalSinkFor posts the open-external envelope on modifier-click", () => {
    const src = "| Link |\n| - |\n| [docs](https://example.com) |";
    const posted: unknown[] = [];
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        extensions: [
          quollOpenExternalSink.of(openExternalSinkFor({ postMessage: (m) => posted.push(m) })),
        ],
      }),
    });
    try {
      const dom = makeWidget(src).toDOM(view);
      const a = dom.querySelector("a");
      expect(a).not.toBeNull();
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
      a?.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(posted).toEqual([
        { protocol: PROTOCOL_VERSION, type: "open-external", href: "https://example.com" },
      ]);
    } finally {
      view.destroy();
    }
  });
});

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

describe("resource-base threading (relative in-cell images)", () => {
  const BASE = "https://csp/ws/notes/a.md";

  it("toDOM resolves a relative in-cell image against the facet base", () => {
    const src = "| ![p](./img.png) |\n| - |";
    const dom = makeWidget(src).toDOM(stubView(undefined, BASE));
    const img = dom.querySelector<HTMLImageElement>("th img");
    expect(img?.getAttribute("src")).toBe("https://csp/ws/notes/img.png");
  });

  it("toDOM renders a traversal in-cell image inert (../ escape)", () => {
    const src = "| ![p](../x.png) |\n| - |";
    const dom = makeWidget(src).toDOM(stubView(undefined, BASE));
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector("th")?.textContent).toBe("![p](../x.png)");
  });

  it("toDOM renders a relative in-cell image inert when no base facet is set", () => {
    const src = "| ![p](./img.png) |\n| - |";
    const dom = makeWidget(src).toDOM(stubView());
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector("th")?.textContent).toBe("![p](./img.png)");
  });

  it("updateDOM (patchRow) resolves a relative image added by a cell edit", () => {
    const srcA = "| a |\n| - |\n| plain |";
    const srcB = "| a |\n| - |\n| ![p](./img.png) |";
    const view = stubView(undefined, BASE);
    const widgetA = makeWidget(srcA);
    const dom = widgetA.toDOM(view);
    expect(makeWidget(srcB).updateDOM(dom, view, widgetA)).toBe(true);
    const img = dom.querySelector<HTMLImageElement>("td img");
    expect(img?.getAttribute("src")).toBe("https://csp/ws/notes/img.png");
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

/** A view stub whose caret resolver is scripted: successive calls return the
 *  successive scripted positions, so a mousedown/click pair can be aimed at two
 *  different characters without a layout engine.
 *
 *  The lookup is scoped to `scope.root` — the widget under test — NOT to
 *  `document.body`. A body-wide search could find a DIFFERENT widget's
 *  identically-texted cell, `root.contains` would reject it, and the drag would
 *  silently degrade to the caret path. That would not merely fail a test — it
 *  would make the "updateDOM cancels an in-flight drag" case pass VACUOUSLY
 *  (its anchor would already be null for the wrong reason). Mount through
 *  `mountWidget`, which owns the `scope.root` assignment. */
function stubViewWithCaret(
  dispatched: unknown[],
  script: Array<{ text: string; offset: number } | null>,
  extensions: Extension[] = []
): { view: EditorViewType; scope: { root: HTMLElement | null } } {
  const scope: { root: HTMLElement | null } = { root: null };
  let i = 0;
  const resolve: CaretResolver = () => {
    const step = script[Math.min(i++, script.length - 1)];
    if (step === null || scope.root === null) {
      return null;
    }
    const walker = document.createTreeWalker(scope.root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      if (n.textContent === step.text) {
        return { node: n, offset: step.offset };
      }
    }
    return null;
  };
  const view = {
    state: EditorState.create({ extensions: [quollTableCaretResolver.of(resolve), ...extensions] }),
    dispatch: (tr: unknown) => dispatched.push(tr),
  } as unknown as EditorViewType;
  return { view, scope };
}

/** Mount a widget the way every drag test needs it: rendered, `scope.root`
 *  wired, and attached to the body. The `scope.root` assignment is the whole
 *  point — done by hand it is a line a new test can forget, and forgetting it
 *  degrades that test to the caret path where it may still pass VACUOUSLY. */
function mountWidget(
  widget: TableBlockWidget,
  view: EditorViewType,
  scope: { root: HTMLElement | null }
): HTMLElement {
  const dom = widget.toDOM(view);
  scope.root = dom;
  document.body.appendChild(dom);
  return dom;
}

/** Dispatch a mouse event carrying coordinates — the movement threshold reads
 *  them, and happy-dom defaults them to 0. `detail: 1` by default because a
 *  real pointer click always carries a click count; `detail: 0` is reserved for
 *  keyboard/programmatic activation, which the drag path deliberately ignores
 *  (override it explicitly to exercise that guard). */
function press(
  el: HTMLElement,
  type: "mousedown" | "click",
  x: number,
  y: number,
  init: MouseEventInit = {}
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    detail: 1,
    ...init,
  });
  el.dispatchEvent(event);
  return event;
}

const SRC = "| Name | Role |\n| - | - |\n| alpha | admin |";

describe("TableBlockWidget drag-selection", () => {
  it("a drag across characters inside one cell dispatches a NON-EMPTY range at the source offsets", () => {
    const base = SRC.indexOf("alpha");
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    expect(dispatched).toEqual([{ selection: { anchor: base + 2, head: base + 5 } }]);
  });

  it("a backwards drag keeps its direction (anchor after head)", () => {
    const base = SRC.indexOf("alpha");
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 4 },
      { text: "alpha", offset: 1 },
    ]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 60, 10);
    press(td, "click", 10, 10);
    expect(dispatched).toEqual([{ selection: { anchor: base + 4, head: base + 1 } }]);
  });

  it("a drag across two cells spans both cells' source offsets", () => {
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 1 },
      { text: "admin", offset: 3 },
    ]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    const cells = dom.querySelectorAll("td");
    press(cells[0] as HTMLElement, "mousedown", 10, 10);
    press(cells[1] as HTMLElement, "click", 200, 10);
    expect(dispatched).toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 1, head: SRC.indexOf("admin") + 3 } },
    ]);
  });

  it("a drag inside a cell whose render is not byte-aligned selects the whole cell source", () => {
    const src = "| Name |\n| - |\n| **bold** |";
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "bold", offset: 1 },
      { text: "bold", offset: 3 },
    ]);
    const dom = mountWidget(makeWidget(src), view, scope);
    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10);
    const from = src.indexOf("**bold**");
    expect(dispatched).toEqual([{ selection: { anchor: from, head: from + "**bold**".length } }]);
  });

  // Regression pin (Fable 95 / Codex 100): without the DRAG_THRESHOLD_PX gate
  // both endpoints of a plain click on a non-aligned cell resolve to
  // `offset: null` and snap outward, turning the click into a whole-cell range.
  it("a PLAIN CLICK on a non-byte-aligned cell still dispatches the collapsed caret", () => {
    const src = "| Name |\n| - |\n| **bold** |";
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "bold", offset: 2 },
      { text: "bold", offset: 2 },
    ]);
    const dom = mountWidget(makeWidget(src), view, scope);
    const td = dom.querySelector("td") as HTMLElement;
    press(td, "mousedown", 30, 10);
    press(td, "click", 30, 10);
    expect(dispatched).toEqual([{ selection: { anchor: src.indexOf("**bold**") } }]);
  });

  // Fable 90 / Codex 98: direction must come from cell order, not from an
  // offset compared against a 0 sentinel.
  it("a backwards drag OUT of a non-byte-aligned cell covers both cells", () => {
    const src = "| A | B |\n| - | - |\n| x | **b** |";
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "b", offset: 1 }, // mousedown in the **b** cell (unmappable)
      { text: "x", offset: 0 }, // drag left into the plain `x` cell
    ]);
    const dom = mountWidget(makeWidget(src), view, scope);
    const cells = dom.querySelectorAll("td");
    press(cells[1] as HTMLElement, "mousedown", 200, 10);
    press(cells[0] as HTMLElement, "click", 10, 10);
    // Anchor snaps OUTWARD to the end of the **b** cell, head is exact in `x`.
    expect(dispatched).toEqual([
      { selection: { anchor: src.indexOf("**b**") + "**b**".length, head: src.indexOf("x") } },
    ]);
  });

  it("a plain click (no movement) still dispatches the collapsed caret at the cell start", () => {
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 3 },
      { text: "alpha", offset: 3 },
    ]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 10);
    press(td, "click", 31, 10); // sub-threshold jitter
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  it("a click with no preceding mousedown still dispatches the collapsed caret", () => {
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 4 }]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    press(dom.querySelectorAll("td")[0] as HTMLElement, "click", 60, 10);
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  it("mousedown alone dispatches NOTHING (no reveal mid-drag)", () => {
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 2 }]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 10, 10);
    expect(dispatched).toEqual([]);
  });

  it("ignores a non-primary-button mousedown", () => {
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10, { button: 2 }); // right-click
    press(td, "click", 60, 10);
    // No anchor was captured, so this is the plain-caret path.
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  // Fable 85 / Codex 95: the anchor must be consumed even on the modifier-click
  // early return, or it leaks into the NEXT gesture.
  it("a modifier-click clears the pending anchor (no leak into the next click)", () => {
    const src = "| L |\n| - |\n| [x](https://example.com) |";
    const dispatched: unknown[] = [];
    const opened: string[] = [];
    // The resolver MUST resolve inside a real cell so the mousedown arms a
    // NON-null point. An earlier version of this test resolved to
    // `document.body`, which the containment gate rejects — `pending.point`
    // was then null, the leak path short-circuited to the very caret dispatch
    // the assertion expects, and the test stayed green WITH the leak present.
    const { view, scope } = stubViewWithCaret(
      dispatched,
      [{ text: "x", offset: 0 }],
      [quollOpenExternalSink.of((href: string) => opened.push(href))]
    );
    const dom = mountWidget(makeWidget(src), view, scope);
    const a = dom.querySelector("a") as HTMLElement;
    press(a, "mousedown", 10, 10);
    press(a, "click", 10, 10, { metaKey: true });
    expect(opened).toEqual(["https://example.com"]);
    expect(dispatched).toEqual([]);
    // The NEXT click, far away and with no mousedown of its own, must not
    // resurrect the cleared anchor. If it leaked, this click sees moved=true
    // with a non-null point (link cell → offset null → whole-cell snap) and
    // dispatches a RANGE spanning the cell instead of the caret below.
    press(dom.querySelector("td") as HTMLElement, "click", 400, 10);
    expect(dispatched).toEqual([
      { selection: { anchor: src.indexOf("[x](https://example.com)") } },
    ]);
  });

  // error-handler 92: a doc edit landing mid-gesture moves the stamps.
  it("updateDOM cancels an in-flight drag (stale-offset guard)", () => {
    // Control arm FIRST. The real assertion below is a NEGATIVE one (expects a
    // caret), so anything that quietly stops the resolver from resolving —
    // a renamed fixture text, a rescoped walker — would produce the same
    // expected value and the test would keep passing while pinning nothing.
    // Proving the identical gesture DOES produce a range means the caret can
    // only come from pendingDrag.delete().
    const control: unknown[] = [];
    const { view: controlView, scope: controlScope } = stubViewWithCaret(control, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const controlDom = mountWidget(makeWidget(SRC), controlView, controlScope);
    const controlTd = controlDom.querySelectorAll("td")[0] as HTMLElement;
    press(controlTd, "mousedown", 10, 10);
    press(controlTd, "click", 60, 10);
    expect(control).toEqual([
      { selection: { anchor: SRC.indexOf("alpha") + 2, head: SRC.indexOf("alpha") + 5 } },
    ]);

    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const first = new TableBlockWidget(parseTable(SRC, 0, SRC.length)!, SRC, 0, 0);
    const dom = mountWidget(first, view, scope);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    // A distant edit shifts this table while the button is still down.
    const shifted = new TableBlockWidget(parseTable(SRC, 0, SRC.length)!, SRC, 5, 5);
    shifted.updateDOM(dom, view, first);
    press(td, "click", 60, 10);
    // The anchor was invalidated → collapsed caret at the NEW stamp, not a
    // range built from two different coordinate systems.
    expect(dispatched).toEqual([{ selection: { anchor: 5 + SRC.indexOf("alpha") } }]);
  });

  // The native mousedown default is what moves focus into CodeMirror's
  // contenteditable; without focus the revealed selection neither paints nor
  // extends. Adding `event.preventDefault()` here is the natural "stop the
  // flicker" change, so the invariant needs its own assertion.
  it("mousedown is NOT preventDefault'ed (the native default is what focuses the editor)", () => {
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [{ text: "alpha", offset: 2 }]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    const event = press(dom.querySelectorAll("td")[0] as HTMLElement, "mousedown", 10, 10);
    expect(event.defaultPrevented).toBe(false);
  });

  // Mirror of "a backwards drag OUT of a non-byte-aligned cell": there the
  // ANCHOR is unmappable, here the HEAD is. Without this the backwards arm of
  // `head.offset ?? (forward ? head.cellTo : head.cellFrom)` is never taken.
  it("a backwards drag ENDING in a non-byte-aligned cell snaps the head OUTWARD", () => {
    const src = "| A | B |\n| - | - |\n| **b** | x |";
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "x", offset: 1 }, // mousedown in the plain `x` cell (mappable)
      { text: "b", offset: 1 }, // drag LEFT into the **b** cell (unmappable)
    ]);
    const dom = mountWidget(makeWidget(src), view, scope);
    const cells = dom.querySelectorAll("td");
    press(cells[1] as HTMLElement, "mousedown", 200, 10);
    press(cells[0] as HTMLElement, "click", 10, 10);
    // Head snaps to the **b** cell's START — outward for a backwards drag, so
    // the range still covers the cell the pointer crossed.
    expect(dispatched).toEqual([
      { selection: { anchor: src.indexOf("x") + 1, head: src.indexOf("**b**") } },
    ]);
  });

  // The threshold's VALUE, its `>=` boundary, and the Manhattan metric are all
  // load-bearing and were previously unpinned: every drag test moved 50-190px
  // and every click test 0-1px, so any threshold in 2..50 passed the suite.
  it.each([
    [{ dx: 3, dy: 0 }, "caret"],
    [{ dx: 0, dy: 3 }, "caret"],
    [{ dx: 4, dy: 0 }, "range"], // exactly DRAG_THRESHOLD_PX → pins `>=`
    [{ dx: 2, dy: 2 }, "range"], // Manhattan sum, not Euclidean distance
  ] as const)("pointer travel %j resolves as a %s", ({ dx, dy }, kind) => {
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 30, 30);
    press(td, "click", 30 + dx, 30 + dy);
    expect(dispatched).toEqual([
      kind === "caret"
        ? { selection: { anchor: SRC.indexOf("alpha") } }
        : { selection: { anchor: SRC.indexOf("alpha") + 2, head: SRC.indexOf("alpha") + 5 } },
    ]);
  });

  // Aborted-gesture guard. A press released OUTSIDE the widget delivers no
  // click to the root, so the armed anchor survives with stale coordinates.
  // The only click that can then reach this handler without a mousedown of its
  // own is a keyboard/programmatic one — `detail === 0`, clientX/Y 0 — which
  // would otherwise read a huge bogus travel and dispatch a range the user
  // never drew. It must take the caret path instead.
  it("a detail-0 click (keyboard / programmatic) never takes the drag path", () => {
    const dispatched: unknown[] = [];
    const { view, scope } = stubViewWithCaret(dispatched, [
      { text: "alpha", offset: 2 },
      { text: "alpha", offset: 5 },
    ]);
    const dom = mountWidget(makeWidget(SRC), view, scope);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    press(td, "mousedown", 10, 10);
    press(td, "click", 60, 10, { detail: 0 });
    expect(dispatched).toEqual([{ selection: { anchor: SRC.indexOf("alpha") } }]);
  });

  // The guard above lives INSIDE dragRange, i.e. BELOW the click handler's
  // modifier-link branch, and that placement is load-bearing: keyboard
  // activation of a focused in-cell link (Enter with Cmd held, and any
  // synthetic `.click()`) carries detail 0, so hoisting the guard to the top of
  // the click listener — the natural simplification, since it reads as a
  // gesture precondition — would make Cmd+Enter on a link do NOTHING while
  // every existing test stayed green. It is not about drags at all; it is about
  // what a detail-0 click may still be allowed to do.
  it("a detail-0 modifier click on an <a> still opens the link (the guard sits BELOW the link branch)", () => {
    const src = "| L |\n| - |\n| [x](https://example.com) |";
    const dispatched: unknown[] = [];
    const opened: string[] = [];
    const { view, scope } = stubViewWithCaret(
      dispatched,
      [{ text: "x", offset: 0 }],
      [quollOpenExternalSink.of((href: string) => opened.push(href))]
    );
    const dom = mountWidget(makeWidget(src), view, scope);
    const a = dom.querySelector("a") as HTMLElement;
    // Keyboard activation: no pointer gesture, so no mousedown and clientX/Y 0.
    const event = press(a, "click", 0, 0, { detail: 0, metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(opened).toEqual(["https://example.com"]);
    expect(dispatched).toEqual([]);
  });
});

describe("TableBlockWidget caret dispatch hardening", () => {
  // The caret path reads `data-cell-from` / `data-doc-from` off the DOM, so it
  // sits on the same trust boundary as the drag path and must use the same
  // gate. A bare `Number(...)` here would not merely be untidy: CodeMirror's
  // `checkSelection` tests `range.to > doc.length` and nothing else, so a `NaN`
  // anchor is ACCEPTED and installs `{anchor: null, head: null}` — a silently
  // broken selection, with no throw for `dispatchSelection`'s catch to see.
  // Hence the assertions below are on the exact dispatched value, not on
  // "something was dispatched".
  it.each([
    ["empty", ""],
    ["negative", "-5"],
    ["fractional", "78.5"],
    ["non-numeric", "abc"],
    ["precision-losing", "9007199254740993"],
  ])("falls back to the block start for a %s cell stamp", (_label, raw) => {
    const dispatched: unknown[] = [];
    const dom = makeWidget(SRC, 7).toDOM(stubView(dispatched));
    document.body.appendChild(dom);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    td.setAttribute("data-cell-from", raw);
    press(td, "click", 10, 10);
    // The block start, NOT `Number(raw)` — reveal-on-caret is line-level, so
    // this still reveals the table; only intra-table precision is lost.
    expect(dispatched).toEqual([{ selection: { anchor: 7 } }]);
  });

  it("falls back to the widget's own docFrom when the ROOT stamp is malformed too", () => {
    const dispatched: unknown[] = [];
    const dom = makeWidget(SRC, 7).toDOM(stubView(dispatched));
    document.body.appendChild(dom);
    const td = dom.querySelectorAll("td")[0] as HTMLElement;
    td.setAttribute("data-cell-from", "abc");
    dom.setAttribute("data-doc-from", "-3");
    press(td, "click", 10, 10);
    // 7 is the constructor argument, which never travelled through the DOM.
    expect(dispatched).toEqual([{ selection: { anchor: 7 } }]);
  });

  // `dispatchSelection` is the single window through which every dispatch in
  // this widget passes, and its catch is unreachable from any fixture the suite
  // can build: with the stamps validated, the throws that remain are a stale
  // out-of-range offset, CodeMirror's re-entrancy error, and a throwing
  // transaction filter — none of which a display-only widget test can stage.
  // Without this pin the whole try/catch could be replaced by a bare
  // `view.dispatch(...)` with the suite still green.
  it("logs and swallows a throwing dispatch instead of letting it escape the DOM listener", () => {
    const view = {
      state: EditorState.create({}),
      dispatch: () => {
        throw new Error("dispatch boom");
      },
    } as unknown as EditorViewType;
    const dom = makeWidget(SRC, 7).toDOM(view);
    document.body.appendChild(dom);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const td = dom.querySelectorAll("td")[0] as HTMLElement;
      expect(() => press(td, "click", 10, 10)).not.toThrow();
      expect(consoleError).toHaveBeenCalledWith("[quoll] table widget selection dispatch failed", {
        selection: { anchor: SRC.indexOf("alpha") },
        err: expect.any(Error),
      });
    } finally {
      consoleError.mockRestore();
    }
  });
});
