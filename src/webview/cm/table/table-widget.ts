// Display-only block widget that renders a GFM Table as a non-editable
// <table> in place of its source. Click-to-reveal: a click on any cell
// dispatches a caret selection to the cell's absolute LF-internal source
// offset (data-cell-from = nodeFrom + cell.from); a click on the widget
// padding/margin (no cell) falls back to the block line-start (data-doc-from).
// A mousedown followed by a click that actually moved (see DRAG_THRESHOLD_PX)
// instead dispatches a RANGE selection between the two RESOLVED source offsets;
// an endpoint whose cell renders non-byte-aligned (inline markup) has no exact
// offset and snaps outward to that cell's data-cell-from/data-cell-to instead.
// Any endpoint that resolves to nothing, and a range that collapses after
// snapping, fall back to the same caret dispatch as a plain click. (See
// cell-point.ts for the pointer→source-offset mapping and why the widget must
// do this itself rather than reading the browser selection at mouseup.)
// The dispatched selection — caret or range — is what fires tableBlockField's
// line-level reveal-on-caret, surfacing the source for editing.
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
import { quollOpenExternalSink } from "../open-external.js";
import { type CellPoint, cellPointAt, quollTableCaretResolver } from "./cell-point.js";
import { renderCellInline } from "./cell-render.js";

// Pointer travel (Manhattan, CSS px) below which a gesture is a CLICK, not a
// drag. Without this gate a plain click on a cell whose render is not
// byte-aligned with its source (`**bold**`, links, code) would resolve both
// endpoints to `offset: null` and dispatch a whole-cell RANGE where today a
// collapsed caret lands — a regression of the existing click contract.
const DRAG_THRESHOLD_PX = 4;

/** Where a drag started, remembered between `mousedown` and `click`.
 *
 *  Keyed on the widget's root ELEMENT rather than held in the `toDOM` closure
 *  because `updateDOM` reuses that element across widget instances: the entry
 *  has to be invalidated exactly when the cell stamps move, which is something
 *  `updateDOM` can do and the closure cannot. A WeakMap so a discarded widget
 *  root takes its entry with it. */
interface PendingDrag {
  readonly x: number;
  readonly y: number;
  readonly point: CellPoint | null;
}
const pendingDrag = new WeakMap<HTMLElement, PendingDrag>();

/** Every selection dispatch out of this widget's DOM listeners goes through
 *  here. Mirrors the destroyed-view-race guard of task-checkbox-command.ts and
 *  fenced-code-language-command.ts: a listener still attached to a detached
 *  widget root can fire during webview tear-down, and that throw must not
 *  escape into the DOM listener unlogged. */
function dispatchSelection(view: EditorView, selection: { anchor: number; head?: number }): void {
  try {
    view.dispatch({ selection });
  } catch (err) {
    console.error("[quoll] table widget selection dispatch failed", { selection, err });
  }
}

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
    // toDOM/updateDOM time is always current.
    const resourceBase = view.state.facet(quollResourceBaseUri);
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

    // Two root listeners, one gesture. `mousedown` only ARMS the gesture
    // (anchor point + coordinates); `click` — which fires after mouseup and
    // already owns the caret dispatch and the modifier-link path — is the sole
    // dispatch seam.
    //
    // Deliberately NOT preventDefault'ed: the native mousedown default is what
    // moves focus into CodeMirror's contenteditable, and without focus the
    // revealed selection would neither paint nor be extendable.
    //
    // A drag inside the widget CANNOT be recovered from the browser selection
    // at mouseup: the widget is a contenteditable=false island and CodeMirror
    // collapses any DOM selection made inside it back to `state.selection` on
    // its next observer flush (verified in real Chromium — see cell-point.ts).
    // So the widget owns the gesture: remember where the pointer went DOWN, and
    // dispatch a RANGE at click time when the pointer actually moved.
    root.addEventListener("mousedown", (event) => {
      // Primary button only — a right/middle press is not a selection gesture,
      // and letting it arm the anchor would pair a context-menu press with an
      // unrelated later click.
      if (event.button !== 0) {
        return;
      }
      // No dispatch here: dispatching would fire the reveal mid-drag and pull
      // the widget out from under the pointer.
      pendingDrag.set(root, {
        x: event.clientX,
        y: event.clientY,
        point: cellPointAt(
          root,
          event.clientX,
          event.clientY,
          view.state.facet(quollTableCaretResolver)
        ),
      });
    });

    // Root click handler: place the caret at the clicked cell's source offset
    // (that selection lands inside the table's lines → tableBlockField reveals
    // the raw source there). A click on the padding/margin (no cell) falls back
    // to the block start via `root.dataset.docFrom`. A click that MOVED past
    // DRAG_THRESHOLD_PX dispatches a range instead.
    //
    // Modifier-click on a live `<a>` (external nav — cell-render left it
    // un-preventDefault'd because the href is absolute AND within
    // MAX_HREF_LENGTH) is the exception: rather than dispatch a caret, route
    // the open through the host `open-external` choke point
    // (quollOpenExternalSink) so the host re-validates the URL before opening,
    // matching link-handlers.ts. The browser's native anchor handler would
    // skip that host re-check. `closest("a")` (not `event.target instanceof
    // HTMLAnchorElement`) so wrapped inline link children resolve;
    // `instanceof HTMLAnchorElement` on the `closest()` result narrows the
    // already-resolved ancestor. `!event.defaultPrevented` mirrors
    // cell-render's single-source-of-truth decision on whether the href opens
    // externally (relative / fragment / oversize hrefs are preventDefault'd
    // there and fall through to caret dispatch below).
    root.addEventListener("click", (event) => {
      // One-shot read: consumed here, above the modifier-link early return, so
      // an anchor can never leak into the NEXT gesture.
      const pending = pendingDrag.get(root) ?? null;
      pendingDrag.delete(root);
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (
        anchor instanceof HTMLAnchorElement &&
        (event.metaKey || event.ctrlKey) &&
        !event.defaultPrevented
      ) {
        // Suppress the native anchor handler (it would open WITHOUT the host
        // re-validation) and route through the sink. A transport throw (panel
        // dispose mid-click) yields a dead-click by design — native nav is
        // NEVER the fallback. The href is guaranteed absolute + within-cap by
        // cell-render, so no empty/oversize guard is needed here.
        event.preventDefault();
        view.state.facet(quollOpenExternalSink)(anchor.getAttribute("href") ?? "");
        return;
      }
      const cell = (event.target as Element | null)?.closest?.("th, td") as HTMLElement | null;
      const stamped = cell?.dataset.cellFrom ?? root.dataset.docFrom;
      const caret = stamped !== undefined ? Number(stamped) : this.docFrom;
      const moved =
        pending !== null &&
        // `detail === 0` means this click was NOT produced by a pointer
        // gesture — keyboard activation of an in-cell `<a>`, or a programmatic
        // `.click()`. Its clientX/Y are 0, so pairing it with an armed anchor
        // would read a large bogus travel and dispatch a range the user never
        // drew. This is also what closes the aborted-gesture window: a press
        // released OUTSIDE the widget delivers no click to `root`, leaving the
        // entry armed, and the only clicks that can then reach this handler
        // without a fresh mousedown of their own are keyboard/programmatic
        // ones (a click retargeted to a common ancestor above the widget never
        // runs this listener at all).
        event.detail > 0 &&
        Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y) >=
          DRAG_THRESHOLD_PX;
      if (!moved || pending === null || pending.point === null) {
        dispatchSelection(view, { anchor: caret });
        return;
      }
      const head = cellPointAt(
        root,
        event.clientX,
        event.clientY,
        view.state.facet(quollTableCaretResolver)
      );
      if (head === null) {
        dispatchSelection(view, { anchor: caret });
        return;
      }
      // Named `dragAnchor`, not `anchor`: the modifier-click branch above
      // already owns a local called `anchor` (the `<a>` element).
      const dragAnchor = pending.point;
      // Direction comes from CELL ORDER first: an unmappable endpoint has no
      // offset to compare, and defaulting it to 0 would call a backwards drag
      // forward and snap the anchor inward, dropping the very cell the pointer
      // crossed.
      const forward =
        dragAnchor.cellFrom === head.cellFrom
          ? dragAnchor.offset === null || head.offset === null
            ? true
            : head.offset >= dragAnchor.offset
          : head.cellFrom > dragAnchor.cellFrom;
      // Snap an unmappable end OUTWARD so the range still covers what the
      // pointer crossed.
      const from = dragAnchor.offset ?? (forward ? dragAnchor.cellFrom : dragAnchor.cellTo);
      const to = head.offset ?? (forward ? head.cellTo : head.cellFrom);
      if (from === to) {
        // Zero-width after snapping — keep the historical caret semantics
        // (cell CONTENT START, not the character under the pointer).
        dispatchSelection(view, { anchor: caret });
        return;
      }
      dispatchSelection(view, { anchor: from, head: to });
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
      // LF-internal absolute source offsets of this cell's content span. `to`
      // is what lets a drag decide whether the rendered text is byte-aligned
      // with the source (see cell-point.ts) and where to snap when it is not.
      el.dataset.cellFrom = String(this.nodeFrom + cell.from);
      el.dataset.cellTo = String(this.nodeFrom + cell.to);
      for (const node of renderCellInline(cell.raw.trim(), resourceBase)) {
        el.appendChild(node);
      }
      tr.appendChild(el);
    }
    return tr;
  }

  updateDOM(dom: HTMLElement, view: EditorView, from: TableBlockWidget): boolean {
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
    // A document edit landed while a drag was in flight. Every offset on this
    // reused element is about to move, so an anchor captured under the OLD
    // stamps must not be paired with a head resolved under the new ones — that
    // would dispatch a selection over an unrelated span. Drop it; the gesture
    // degrades to the collapsed caret.
    pendingDrag.delete(dom);
    // Re-stamp the margin fallback so a reused element tracks the new docFrom
    // after a distant edit shifted this table without changing its bytes.
    dom.dataset.docFrom = String(this.docFrom);
    // Pure positional shift: the bytes are identical (from.slice === this.slice)
    // and only the absolute offsets moved. Re-stamp data-cell-from on each cell
    // and reuse the rendered inline children verbatim — skip patchRow's
    // textContent="" + renderCellInline re-tokenize (its own design comment,
    // :16-18). This is the hot path when typing in a paragraph ABOVE the table.
    if (from.slice === this.slice) {
      this.stampRow(headerRows[0], this.table.header.cells);
      for (let rowIdx = 0; rowIdx < this.table.rows.length; rowIdx++) {
        this.stampRow(bodyRows[rowIdx] as Element, this.table.rows[rowIdx].cells);
      }
      return true;
    }
    // Content edit (slice changed): full re-render. patchRow re-stamps cellFrom
    // itself (:198), so offsets stay correct on this path too.
    const resourceBase = view.state.facet(quollResourceBaseUri);
    const align = tableAlign(this.table);
    this.patchRow(headerRows[0], this.table.header.cells, align, resourceBase);
    for (let rowIdx = 0; rowIdx < this.table.rows.length; rowIdx++) {
      this.patchRow(
        bodyRows[rowIdx] as Element,
        this.table.rows[rowIdx].cells,
        align,
        resourceBase
      );
    }
    return true;
  }

  /** Re-stamp absolute cell offsets on a reused row WITHOUT touching content.
   *  Safe only when the slice is unchanged: the DOM grid then matches this.table
   *  1:1 (same cell.from values; only nodeFrom shifted). Alignment is unchanged
   *  too, so textAlign is left as-is. */
  private stampRow(tr: Element, cells: readonly Cell[]): void {
    const domCells = tr.querySelectorAll("th, td");
    for (let col = 0; col < cells.length; col++) {
      const el = domCells[col] as HTMLElement | undefined;
      if (el) {
        el.dataset.cellFrom = String(this.nodeFrom + cells[col].from);
        el.dataset.cellTo = String(this.nodeFrom + cells[col].to);
      }
    }
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
      el.dataset.cellTo = String(this.nodeFrom + cell.to);
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
