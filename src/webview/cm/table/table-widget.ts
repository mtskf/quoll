// Display-only block widget that renders a GFM Table as a non-editable
// <table> in place of its source. Click-to-reveal: a click on any cell
// dispatches a caret selection to the cell's absolute LF-internal source
// offset (data-cell-from = nodeFrom + cell.from); a click on the widget
// padding/margin (no cell) falls back to the block line-start, carried in the
// module-private `blockStart` WeakMap (NOT read back out of the DOM).
// A mousedown followed by a click that actually moved (see DRAG_THRESHOLD_PX)
// instead dispatches a RANGE selection between the two RESOLVED source offsets;
// an endpoint the cell's source map cannot place exactly (a boundary beside a
// construct that renders no text, e.g. an in-cell image) has no exact offset.
// ACROSS cells that endpoint alone snaps OUTWARD to its own data-cell-from /
// data-cell-to (direction from cell order) and the other end keeps its offset;
// WITHIN one cell there is no direction to snap along, so the whole gesture
// falls back to that cell's data-cell-from..data-cell-to — the end that DID
// map exactly is discarded too.
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
// a rebuild reuses the existing DOM. updateDOM re-points both channels on reuse
// (cell stamps on the DOM, block start in `blockStart`) so a margin/cell click
// after a shift uses the new offsets, not a stale toDOM-time closure.

import { type EditorView, WidgetType } from "@codemirror/view";

import { type Align, type Cell, type Table, tableAlign } from "../../../markdown/table/index.js";
import { quollResourceBaseUri } from "../image/resource-base.js";
import { quollOpenExternalSink } from "../open-external.js";
import {
  type CellPoint,
  cellPointAt,
  quollTableCaretResolver,
  stampedOffset,
} from "./cell-point.js";
import { renderCellInto } from "./cell-render.js";

// Pointer travel (Manhattan, CSS px) below which a gesture is a CLICK, not a
// drag. Without this gate a plain click on a cell whose pointer position has no
// exact source offset (a boundary beside an in-cell image) would resolve both
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
  /** The press point RELATIVE TO THE CONTENT, not to the viewport. The content
   *  can move under a held pointer — a scroll mid-gesture, a `scrollIntoView`
   *  from an incoming host message, CodeMirror's own scrolling — and a pointer
   *  that stayed still through one of those HAS crossed text. Two `clientX/Y`
   *  pairs cannot see that, and called the gesture a click.
   *
   *  Relative to `contentDOM`'s rect rather than `scrollDOM`'s scroll offsets so
   *  that both operands are VISUAL pixels: CodeMirror supports being CSS
   *  transformed (`view.scaleX` / `scaleY` exist for exactly that), and mixing a
   *  viewport coordinate with a layout-space scroll offset breaks the threshold
   *  under any scale but 1. Measuring both ends the same way makes the scale
   *  cancel instead of needing a correction. */
  readonly contentX: number;
  readonly contentY: number;
  readonly point: CellPoint | null;
}
const pendingDrag = new WeakMap<HTMLElement, PendingDrag>();

/** The block's CURRENT first-byte offset (margin-click caret target), keyed on
 *  the widget's root element for the same reason `pendingDrag` is: `updateDOM`
 *  reuses that element across widget instances and cannot re-bind the click
 *  listener, whose captured `this` stays the OLD instance — so the new instance
 *  needs a channel to the existing listener that moves exactly when the block
 *  moves, which `updateDOM` can write and the closure cannot.
 *
 *  A `number` end to end: unlike the per-CELL offsets it is never stringified,
 *  parsed, or read back from the DOM, so there is no malformed-value state to
 *  gate — which is why `stampedOffset` guards those stamps and not this one
 *  (its docblock has what CodeMirror does NOT catch). Same channel, same
 *  rationale, as image-widget.ts's `blockStart`. */
const blockStart = new WeakMap<HTMLElement, number>();

/** Aborts the document-level listeners armed for the gesture in flight on this
 *  root. Kept OUT of `PendingDrag` because the two have different lifetimes:
 *  `updateDOM` drops the pending anchor when a doc edit invalidates it while the
 *  gesture is still physically in progress, and that release must still be heard
 *  (it dispatches the block-start caret). A WeakMap so a discarded root takes its
 *  controller with it — though the listeners are removed by the gesture's own end
 *  and by `destroy`, not left to garbage collection. */
const armedRelease = new WeakMap<HTMLElement, AbortController>();

/** Margin-click caret: the block start this root currently points at.
 *
 *  Falling back to the toDOM-time `widget.docFrom` totalizes the
 *  `number | undefined` read; it is not the stale-closure hazard coming back.
 *  The entry is written in `toDOM` in the same breath as attaching the listener,
 *  and at that moment the closure value IS the current one — so a miss is
 *  unreachable by construction. Logged rather than trusted, so a future
 *  regression of that invariant is observable instead of quietly reintroducing
 *  the stale-caret bug this WeakMap exists to prevent. */
function blockStartCaret(root: HTMLElement, widget: TableBlockWidget): number {
  const current = blockStart.get(root);
  if (current === undefined) {
    // `slice` identifies WHICH widget tripped it — a document can hold many
    // tables, and `fallback` alone would not say which one.
    console.error("[quoll] table widget blockStart miss — invariant violated", {
      slice: widget.slice,
      fallback: widget.docFrom,
    });
    return widget.docFrom;
  }
  return current;
}

/** Every selection dispatch out of this widget's DOM listeners goes through
 *  here, so the throw paths are handled in ONE place rather than at each seam.
 *
 *  What can actually throw, after the callers below validate every offset they
 *  read from the DOM: (1) `RangeError: Selection points outside of document` —
 *  `checkSelection` (@codemirror/state) rejects `range.to > doc.length`, and a
 *  stamp read off a widget root that outlived a shrinking edit is exactly that;
 *  (2) `Calls to EditorView.update are not allowed while an update is in
 *  progress` — this listener runs on a DOM event, which an in-progress update
 *  can deliver; (3) anything a transaction filter/extender in this view's
 *  pipeline throws. A dispatch to a DESTROYED view is NOT one of them —
 *  `EditorView.update` early-returns for `this.destroyed` (@codemirror/view
 *  6.43.0), so tear-down races are a silent no-op, not a throw.
 *
 *  Either way the throw must not escape into a DOM listener unlogged: the
 *  gesture is lost, the editor keeps running. */
function dispatchSelection(view: EditorView, selection: { anchor: number; head?: number }): void {
  try {
    view.dispatch({ selection });
  } catch (err) {
    console.error("[quoll] table widget selection dispatch failed", { selection, err });
  }
}

/** A pointer position in the CONTENT's frame of reference. */
function contentPoint(view: EditorView, event: MouseEvent): { x: number; y: number } {
  const origin = view.contentDOM.getBoundingClientRect();
  return { x: event.clientX - origin.left, y: event.clientY - origin.top };
}

/** Manhattan pointer travel since the press, over the CONTENT. One measurement
 *  in one frame, so a pointer that follows moving content cancels out and stays
 *  a click. Manhattan (not Euclidean) to match the threshold the suite pins. */
function travelSince(view: EditorView, pending: PendingDrag, event: MouseEvent): number {
  const now = contentPoint(view, event);
  return Math.abs(now.x - pending.contentX) + Math.abs(now.y - pending.contentY);
}

/** A `PendingDrag` whose press landed on a cell — the only kind either seam can
 *  build a range from. */
interface ArmedDrag extends PendingDrag {
  readonly point: CellPoint;
}

/** Is this completed gesture a DRAG (rather than a click, a keyboard or
 *  programmatic activation, or nothing this widget armed)? ONE definition for
 *  both seams, so the click and the outside release can never disagree about
 *  what a drag is.
 *
 *  `detail === 0` means the event was NOT produced by a pointer gesture —
 *  keyboard activation of an in-cell `<a>`, or a programmatic `.click()` /
 *  `dispatchEvent`. Its clientX/Y are 0, so pairing it with an armed anchor
 *  would read a large bogus travel and dispatch a range the user never drew. */
function isDrag(
  view: EditorView,
  event: MouseEvent,
  pending: PendingDrag | null
): pending is ArmedDrag {
  if (pending === null || pending.point === null) {
    return false;
  }
  if (event.detail === 0) {
    return false;
  }
  return travelSince(view, pending, event) >= DRAG_THRESHOLD_PX;
}

/** The RANGE a completed pointer gesture describes, or `null` when this gesture
 *  is not a drag at all (see `isDrag`), when the head has no mapping, or when
 *  the range collapses after snapping. Every `null` answer means the same thing
 *  to the caller: dispatch the plain collapsed caret instead.
 *
 *  The aborted-gesture window this used to close through `detail === 0` is now
 *  ALSO closed structurally: the release seam disarms itself on every mouseup,
 *  and any press elsewhere disarms a gesture whose release never arrived. */
function dragRange(
  view: EditorView,
  root: HTMLElement,
  event: MouseEvent,
  pending: PendingDrag | null
): { anchor: number; head: number } | null {
  if (!isDrag(view, event, pending)) {
    return null;
  }
  const head = cellPointAt(
    root,
    event.clientX,
    event.clientY,
    view.state.facet(quollTableCaretResolver)
  );
  if (head === null) {
    return null;
  }
  const start = pending.point;
  if (start.cellFrom === head.cellFrom) {
    // ONE cell. An unmappable end carries no direction here: a rendered offset
    // beside a construct that renders no text measures the SAME on both sides
    // of it (cell-point.ts), so "which way did the pointer go" is unknowable
    // and the OTHER end cannot supply it either — snapping the unmappable end
    // to a guessed cell boundary would dispatch a range on the side the pointer
    // never crossed. Fail closed to the whole cell (the pre-map contract).
    if (start.offset === null || head.offset === null) {
      // `cellFrom === cellTo` (an EMPTY cell) with `offset === null` is not
      // reachable through the current src path — `renderCellInto("")` registers
      // a map for the empty cell too, and its single boundary answers exactly
      // (`sourceOffsetAt` returns 0 for `within === 0 && sourceLength === 0`).
      // Kept as defense in depth against a zero-width whole-cell dispatch, and
      // deliberately NOT pinned: the only fixture that could reach it would
      // have to fake a resolver answer no browser produces.
      return start.cellFrom === start.cellTo
        ? null
        : { anchor: start.cellFrom, head: start.cellTo };
    }
    // Both ends exact: the offsets ARE the range, in the order they were made.
    // Zero-width — the caller's caret keeps the historical semantics (cell
    // CONTENT START, not the character under the pointer).
    return start.offset === head.offset ? null : { anchor: start.offset, head: head.offset };
  }
  // Across cells the direction comes from CELL ORDER, not from the offsets: an
  // unmappable endpoint has no offset to compare, and defaulting it to 0 would
  // call a backwards drag forward and snap the anchor inward, dropping the very
  // cell the pointer crossed. Cell order is known for both ends regardless.
  const forward = head.cellFrom > start.cellFrom;
  // Snap an unmappable end OUTWARD — away from the other end — so the range
  // still covers the cell the pointer crossed.
  const from = start.offset ?? (forward ? start.cellFrom : start.cellTo);
  const to = head.offset ?? (forward ? head.cellTo : head.cellFrom);
  // Zero-width after snapping (adjacent cells, both ends on the same boundary).
  return from === to ? null : { anchor: from, head: to };
}

/** The RANGE a gesture RELEASED OUTSIDE this widget describes, or `null` when it
 *  is not a drag, when the press was not on a cell, or when the editor cannot
 *  place the release point — every one of which the caller answers with the
 *  collapsed caret, the same degrade the click seam uses.
 *
 *  The head comes from `view.posAtCoords` rather than from `cellPointAt`: the
 *  release is outside the widget by construction, so there is no cell to map and
 *  the editor's own coordinate lookup IS the answer. It returns `null` for a
 *  point it cannot resolve (an unrendered block, a viewport gap) — but NOT for
 *  an overshoot: past the last line it clamps to `doc.length`, and above the
 *  first to `0` (@codemirror/view 6.43.0), which is why a release below the
 *  document still draws a range to the end rather than degrading.
 *
 *  Direction comes from comparing that document position with the cell, for the
 *  same reason the across-cells arm of `dragRange` uses cell order: an
 *  unmappable anchor has no offset to compare, and it snaps OUTWARD — away from
 *  the release — so the range still covers the cell the pointer started in. */
function releaseRange(
  view: EditorView,
  event: MouseEvent,
  pending: PendingDrag | null
): { anchor: number; head: number } | null {
  if (!isDrag(view, event, pending)) {
    return null;
  }
  let head: number | null;
  try {
    head = view.posAtCoords({ x: event.clientX, y: event.clientY });
  } catch (err) {
    // Same contract as `dispatchSelection`'s catch: a coordinate lookup against
    // a view torn down mid-gesture must cost the gesture, not the editor.
    console.error("[quoll] table widget release lookup failed", { err });
    return null;
  }
  if (head === null) {
    return null;
  }
  const start = pending.point;
  const anchor = start.offset ?? (head > start.cellFrom ? start.cellFrom : start.cellTo);
  return anchor === head ? null : { anchor, head };
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
    // The margin-click caret travels through `blockStart`, NOT through this
    // attribute: `data-doc-from` is written for DOM inspection (and read by the
    // tests that pin the re-stamp) and is NEVER read back — see `blockStart`
    // above for why this position must not be parsed back out of the DOM.
    root.dataset.docFrom = String(this.docFrom);
    blockStart.set(root, this.docFrom);

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
    // The widget owns the gesture end to end because a drag CANNOT be recovered
    // from the browser selection at mouseup (cell-point.ts, "Why this exists"):
    // remember where the pointer went DOWN, dispatch a RANGE at click time.
    root.addEventListener("mousedown", (event) => {
      // Primary button only — a right/middle press is not a selection gesture,
      // and letting it arm the anchor would pair a context-menu press with an
      // unrelated later click.
      if (event.button !== 0) {
        return;
      }
      // No dispatch here: dispatching would fire the reveal mid-drag and pull
      // the widget out from under the pointer.
      const at = contentPoint(view, event);
      pendingDrag.set(root, {
        contentX: at.x,
        contentY: at.y,
        // `cellPointAt` keeps taking VIEWPORT coordinates — it feeds
        // `caretPositionFromPoint`, which is a viewport API. Only the travel
        // measurement changes frame.
        point: cellPointAt(
          root,
          event.clientX,
          event.clientY,
          view.state.facet(quollTableCaretResolver)
        ),
      });

      // The SECOND dispatch seam. A gesture released outside this root never
      // delivers a `click` here — measured in real Chromium: the click is
      // retargeted to `.cm-content`, the nearest common ancestor of the press
      // and release targets — so the release has to be heard on the document,
      // where every mouseup lands. Armed per gesture rather than kept
      // permanently, so the listener that can dispatch is exactly the one
      // belonging to the press in flight. Any controller left over from a
      // previous press is aborted first, so at most one is ever armed.
      armedRelease.get(root)?.abort();
      const release = new AbortController();
      armedRelease.set(root, release);
      const doc = root.ownerDocument;
      const armingPress = event;
      doc.addEventListener(
        "mouseup",
        (up: MouseEvent) => {
          // BEFORE the abort, not after: a right-button press-and-release while
          // the left button is held delivers a mouseup this gesture did not end.
          // Aborting first would leave the real release with no listener.
          if (up.button !== 0) {
            return;
          }
          release.abort(); // one-shot: this gesture is over either way
          // The root left the document mid-gesture — CodeMirror rebuilds a
          // widget by REPLACING its root, and a detached root's stamps have
          // stopped tracking the document. The click seam never had to check
          // (a detached root receives no clicks); a document-level one does.
          if (!root.isConnected) {
            return;
          }
          // Released INSIDE: the click WILL reach this root, and it owns the
          // dispatch — including the modifier-link `open-external` branch, which
          // stays exactly where it was. Leave `pendingDrag` armed for it.
          if (root.contains(up.target as Node | null)) {
            return;
          }
          const pending = pendingDrag.get(root) ?? null;
          pendingDrag.delete(root);
          dispatchSelection(
            view,
            releaseRange(view, up, pending) ?? {
              anchor: pending?.point?.cellFrom ?? blockStartCaret(root, this),
            }
          );
        },
        { signal: release.signal }
      );
      // ⚠️ The guard that makes the seam safe rather than merely useful.
      //
      // A release this document never sees — the pointer leaves the webview
      // iframe, focus is lost, Cmd+Tab — leaves the listener above armed, and
      // the user's NEXT unrelated release would be read as this gesture's end:
      // a range from a table cell to a point nobody dragged to. A press is the
      // one thing that must precede any such release, so disarming here covers
      // every focus-loss path, including the ones nobody enumerated.
      //
      // CAPTURE, and that is the load-bearing part. Four sibling widgets in this
      // editor call stopPropagation() on mousedown — the task checkbox, the
      // fenced-code copy and collapse buttons, the language picker — and NONE of
      // them stops mouseup. A bubble-phase disarm is therefore starved by
      // exactly those presses while the release still arrives, which is the one
      // combination that dispatches a range the user never drew (measured:
      // bubble 0, capture 1, mouseup delivered). Capture runs document → target,
      // so nothing downstream can starve it.
      //
      // The identity check guards the other direction: this listener is added
      // DURING the dispatch of the arming press. In capture that press has
      // already passed the document, so it cannot reach here — but the check
      // costs one line, says out loud what must stay true, and keeps the guard
      // correct if the phase is ever changed back. Comparing the event OBJECT,
      // not the target, which a second press in the same cell would match too.
      doc.addEventListener(
        "mousedown",
        (down: MouseEvent) => {
          if (down === armingPress || down.button !== 0) {
            return;
          }
          release.abort();
          pendingDrag.delete(root);
        },
        { signal: release.signal, capture: true }
      );
      // A native drag-and-drop ends in `dragend`, NOT in a mouseup. Measured: a
      // plain cell drag starts no DnD at all, so this is for a press that begins
      // on an in-cell <img> or <a>, both natively draggable. Nothing is
      // preventDefault'ed — the selection seam simply stands down, because a
      // drag-and-drop is not a text selection.
      doc.addEventListener(
        "dragstart",
        () => {
          release.abort();
          pendingDrag.delete(root);
        },
        { signal: release.signal, capture: true }
      );
    });

    // Root click handler — the sole dispatch seam for the caret/range contract
    // described at the top of this file.
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
      const cell = (event.target as Element | null)?.closest?.("th, td") ?? null;
      // The CELL offset must stay on the DOM — `cellPointAt` resolves an
      // arbitrary descendant under the pointer, so no closure knows which cell
      // was clicked. That makes it a trust boundary, read through the SAME gate
      // the drag path uses (`stampedOffset`) rather than a bare `Number(...)`;
      // its docblock has the why — CodeMirror accepts a `NaN` anchor and
      // installs a broken selection `dispatchSelection`'s catch never sees.
      //
      // A stamp that fails the gate degrades one step rather than dispatching
      // nothing: reveal-on-caret is LINE-level, so the block start reveals the
      // same table the cell offset would — only the intra-table caret precision
      // is lost, and a dead click (no reveal at all) is a worse answer for a
      // failure mode that only arises when something outside this widget wrote
      // its DOM. That "same table" guarantee is unconditional now that the block
      // start comes from `blockStart`, which `updateDOM` re-points: it can no
      // longer be a stale closure value pointing at a DIFFERENT block.
      const caret =
        (cell === null ? null : stampedOffset(cell, "data-cell-from")) ??
        blockStartCaret(root, this);
      dispatchSelection(view, dragRange(view, root, event, pending) ?? { anchor: caret });
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
      // LF-internal absolute source offsets of this cell's content span. They
      // are ALSO where a drag across cells snaps OUTWARD when the pointer lands
      // on a boundary the cell's source map cannot resolve exactly — `to` when
      // this cell is the LATER end of the drag, `from` when it is the earlier
      // one, so the range still covers what the pointer crossed. Both stamps
      // together are the whole-cell range a same-cell drag falls back to (see
      // dragRange / cell-point.ts).
      el.dataset.cellFrom = String(this.nodeFrom + cell.from);
      el.dataset.cellTo = String(this.nodeFrom + cell.to);
      // `cell.raw` VERBATIM, never `.trim()`: the parser's cell trimming is
      // ASCII space/tab only, while JS `trim()` also strips NBSP, U+FEFF and
      // every other Unicode space — so for `| <NBSP>x |` the stamps would
      // bracket `<NBSP>x` while the render showed `x`, putting the source map
      // off by one against `cellFrom`. `Cell.raw` is already the padding-free
      // [from, to) slice (raw.length === cell.to - cell.from on both pushCell
      // paths), so trimming was redundant, and dropping it makes "rendered text
      // is anchored at cellFrom" true by construction. An exotic space inside a
      // cell is content.
      renderCellInto(el, cell.raw, resourceBase);
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
    // Re-point the margin-click caret channel the click listener actually reads,
    // so a reused element tracks the new docFrom after a distant edit shifted
    // this table without changing its bytes. The attribute beside it is
    // inspection-only (see toDOM) — dropping THIS line would leave the reused
    // listener dispatching the old offset while the DOM still looked correct.
    dom.dataset.docFrom = String(this.docFrom);
    blockStart.set(dom, this.docFrom);
    // Pure positional shift: the bytes are identical (from.slice === this.slice)
    // and only the absolute offsets moved. Re-stamp data-cell-from on each cell
    // and reuse the rendered inline children verbatim — skip patchRow's
    // textContent="" + renderCellInto re-tokenize (its own design comment,
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
      // Verbatim `cell.raw` and the map-registering renderer, for the reasons
      // in buildRow: `renderCellInto` clears the cell itself, so a reused cell
      // can never keep the previous render's source map.
      renderCellInto(el, cell.raw, resourceBase);
    }
  }

  ignoreEvent(): boolean {
    return true;
  }

  /** CodeMirror's documented teardown for a widget instance. The gesture
   *  listeners live on the DOCUMENT and close over `root`, so without this a
   *  widget destroyed mid-gesture keeps both the listeners and the DOM alive —
   *  and the listeners keep answering for an editor that has forgotten them.
   *  The `isConnected` guard in the release seam is not a substitute: `destroy`
   *  can be called while the DOM is still in the tree. */
  destroy(dom: HTMLElement): void {
    armedRelease.get(dom)?.abort();
    armedRelease.delete(dom);
    pendingDrag.delete(dom);
  }
}
