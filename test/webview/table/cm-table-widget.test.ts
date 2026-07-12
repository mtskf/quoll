// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView, type EditorView as EditorViewType, WidgetType } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { parseTable } from "../../../src/markdown/table/index.js";
import { PROTOCOL_VERSION } from "../../../src/shared/protocol.js";
import { quollResourceBaseUri } from "../../../src/webview/cm/image/resource-base.js";
import {
  openExternalSinkFor,
  quollOpenExternalSink,
} from "../../../src/webview/cm/open-external.js";
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
