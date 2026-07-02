// Display-only block widget that renders a GFM Table as a non-editable
// <table> in place of its source. Click-to-reveal: a click on any cell
// dispatches a caret selection to the cell's absolute LF-internal source
// offset (data-cell-from = nodeFrom + cell.from); a click on the widget
// padding/margin (no cell) falls back to the block line-start (data-doc-from).
// The dispatched selection is what fires tableBlockField's line-level
// reveal-on-caret, surfacing the source for editing.
//
// eq() is keyed on (docFrom, slice, nodeFrom). docFrom is the absolute
// LF-internal doc offset of the widget's first byte (block line-start, NOT
// table.from, which is always 0 under per-node slicing — see Codex re-review
// Conf 82). nodeFrom is the Lezer Table node start — the base for each cell's
// caret offset (nodeFrom + cell.from). Both are LF-internal (seed.ts
// splitToCmText strips \r). Two tables at different doc positions or with
// different Lezer node starts are NOT eq; same (docFrom, slice, nodeFrom) on
// a rebuild reuses the existing DOM. updateDOM re-stamps both on reuse so a
// margin/cell click after a shift uses the new offsets, not a stale toDOM-time
// closure.

import { type EditorView, WidgetType } from "@codemirror/view";

import { type Align, type Cell, type Table, tableAlign } from "../../../markdown/table/index.js";
import { quollResourceBaseUri } from "../image/resource-base.js";
import { renderCellInline } from "./cell-render.js";

export class TableBlockWidget extends WidgetType {
  constructor(
    readonly table: Table,
    /** LF-normalised source slice (table-skeleton's `m.slice`) — eq() key.
     *  A byte change rebuilds; matches the pre-existing widget identity. */
    readonly slice: string,
    /** Absolute LF-internal doc offset of the widget's first byte (block
     *  line-start). Margin-click caret fallback + part of eq(). */
    readonly docFrom: number,
    /** Absolute LF-internal doc offset of the Lezer `Table` node start — base
     *  for each cell's caret offset (`nodeFrom + cell.from`). CodeMirror is
     *  LF-internal (seed.ts splitToCmText strips \r), so cell.from — an offset
     *  into the LF-normalised parse slice — is already a valid CM position and
     *  needs NO CRLF correction. Usually equals docFrom; differs only when the
     *  node range is not line-aligned (doc-final-no-newline / partial-tree). */
    readonly nodeFrom: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof TableBlockWidget &&
      other.docFrom === this.docFrom &&
      other.slice === this.slice &&
      other.nodeFrom === this.nodeFrom
    );
  }

  toDOM(view: EditorView): HTMLElement {
    // Wrapper <div> (not <table>) is the widget root: it carries the
    // `quoll-block` margin:0 invariant and delivers breathing room via padding,
    // which getBoundingClientRect INCLUDES (margin it excludes) so CM's
    // block-widget height measurement stays in lockstep with the visible DOM.
    const root = document.createElement("div");
    root.className = "quoll-block quoll-table-block";
    // Margin-click caret fallback, stored on the DOM so a reused element
    // (updateDOM) reflects the CURRENT docFrom, not a stale toDOM-time closure.
    root.dataset.docFrom = String(this.docFrom);

    // Resource base for relative in-cell image srcs. Static per editor
    // (resource-base.ts), so it is NOT part of eq() — reading it at
    // toDOM/updateDOM time is always current. Fail-closed: no state → "".
    const resourceBase = view.state?.facet(quollResourceBaseUri) ?? "";
    const align = tableAlign(this.table);
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    thead.appendChild(this.buildRow("th", this.table.header.cells, align, "header", resourceBase));
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (const row of this.table.rows) {
      tbody.appendChild(this.buildRow("td", row.cells, align, "body", resourceBase));
    }
    table.appendChild(tbody);
    root.appendChild(table);

    // Single root click handler: place the caret at the clicked cell's source
    // offset (that selection lands inside the table's lines → tableBlockField
    // reveals the raw source there). A click on the padding/margin (no cell)
    // falls back to the block start via `root.dataset.docFrom`.
    //
    // Modifier-click on a live `<a>` (external nav — cell-render left it
    // un-preventDefault'd) is the exception: moving the caret would fight the
    // browser navigation. `closest("a")` (not `event.target instanceof HTMLAnchorElement`)
    // so wrapped inline link children resolve; `instanceof HTMLAnchorElement` on the
    // `closest()` result is correct — it narrows the already-resolved ancestor.
    // `!event.defaultPrevented` mirrors cell-render's
    // single-source-of-truth decision on whether the href opens externally.
    root.addEventListener("click", (event) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (
        anchor instanceof HTMLAnchorElement &&
        (event.metaKey || event.ctrlKey) &&
        !event.defaultPrevented
      ) {
        return;
      }
      const cell = (event.target as Element | null)?.closest?.("th, td") as HTMLElement | null;
      const stamped = cell?.dataset.cellFrom ?? root.dataset.docFrom;
      const target = stamped !== undefined ? Number(stamped) : this.docFrom;
      view.dispatch({ selection: { anchor: target } });
    });

    return root;
  }

  private buildRow(
    tag: "th" | "td",
    cells: readonly Cell[],
    // `undefined` included so the ragged-row OOB-index path narrows correctly
    // under `noUncheckedIndexedAccess: false` (see markdown/table/model.ts).
    align: readonly (Align | undefined)[],
    kind: "header" | "body",
    resourceBase: string
  ): HTMLTableRowElement {
    const tr = document.createElement("tr");
    for (let col = 0; col < cells.length; col++) {
      const cell = cells[col];
      const el = document.createElement(tag);
      if (kind === "header") {
        el.setAttribute("scope", "col"); // WCAG H63 explicit column-header scope.
      }
      const a = align[col];
      el.style.textAlign = a !== null && a !== undefined ? a : "";
      // LF-internal absolute source offset of this cell's content start.
      el.dataset.cellFrom = String(this.nodeFrom + cell.from);
      for (const node of renderCellInline(cell.raw.trim(), resourceBase)) {
        el.appendChild(node);
      }
      tr.appendChild(el);
    }
    return tr;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    // CM calls updateDOM only when eq() returned false. Validate the grid shape;
    // any structural change → return false so CM does a full toDOM rebuild.
    if (!dom.classList.contains("quoll-table-block")) {
      return false;
    }
    const thead = dom.querySelector("thead");
    const tbody = dom.querySelector("tbody");
    if (!thead || !tbody) {
      return false;
    }
    const headerRows = thead.querySelectorAll("tr");
    const bodyRows = tbody.querySelectorAll("tr");
    if (headerRows.length !== 1 || bodyRows.length !== this.table.rows.length) {
      return false;
    }
    if (headerRows[0].querySelectorAll("th, td").length !== this.table.header.cells.length) {
      return false;
    }
    // Ragged body rows: cell counts can change independently of the header.
    for (let rowIdx = 0; rowIdx < this.table.rows.length; rowIdx++) {
      const tr = bodyRows[rowIdx];
      if (!tr || tr.querySelectorAll("th, td").length !== this.table.rows[rowIdx].cells.length) {
        return false;
      }
    }
    // Re-stamp the margin fallback so a reused element tracks the new docFrom
    // after a distant edit shifted this table without changing its bytes.
    dom.dataset.docFrom = String(this.docFrom);
    const resourceBase = view.state?.facet(quollResourceBaseUri) ?? "";
    const align = tableAlign(this.table);
    this.patchRow(headerRows[0], this.table.header.cells, align, resourceBase);
    for (let rowIdx = 0; rowIdx < this.table.rows.length; rowIdx++) {
      this.patchRow(bodyRows[rowIdx] as Element, this.table.rows[rowIdx].cells, align, resourceBase);
    }
    return true;
  }

  private patchRow(
    tr: Element,
    cells: readonly Cell[],
    align: readonly (Align | undefined)[],
    resourceBase: string
  ): void {
    const domCells = tr.querySelectorAll("th, td");
    for (let col = 0; col < cells.length; col++) {
      const el = domCells[col] as HTMLElement | undefined;
      if (!el) {
        continue;
      }
      const cell = cells[col];
      const a = align[col];
      el.style.textAlign = a !== null && a !== undefined ? a : "";
      el.dataset.cellFrom = String(this.nodeFrom + cell.from);
      el.textContent = "";
      for (const node of renderCellInline(cell.raw.trim(), resourceBase)) {
        el.appendChild(node);
      }
    }
  }

  ignoreEvent(): boolean {
    return true;
  }
}
