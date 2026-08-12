// Map a viewport point inside a rendered table widget to ABSOLUTE LF-internal
// source offsets, so a drag over the display-only widget can be replayed as a
// CodeMirror range selection.
//
// Why this exists: the widget's DOM is a `contenteditable=false` island inside
// CodeMirror's editable content, and CodeMirror ACTIVELY DESTROYS any browser
// selection made inside it — DOMObserver.flush() sees a selection it cannot map
// to a document position, concludes the view is out of sync, and runs
// `view.update([])` → `docView.updateSelection()`, collapsing the DOM selection
// back to `state.selection`. Verified in real Chromium (2026-08-12): the first
// mousemove yields a real Range, the next event resets it to document position
// 0, and every later mousemove lands a fresh collapsed caret. So the widget
// cannot read `window.getSelection()` at mouseup — it must map pointer
// COORDINATES itself. Hence this module.
//
// Byte-alignment rule: the widget renders `cell.raw.trim()` through the inline
// tokenizer, so a cell holding `**bold**` (8 source bytes) renders as `bold`
// (4 characters) and a DOM character offset is NOT addable to the cell's source
// offset. The parser already trims cell padding (`Cell.from`/`to` bracket the
// content, excluding `leadingSpace`/`trailingSpace`), so for a cell with no
// inline constructs `renderedText.length === cellTo - cellFrom` holds exactly.
// That length equality is the alignment test: equal → offsets map 1:1; unequal
// → `offset` is reported as `null` and the caller snaps to a cell boundary
// rather than inventing a wrong position.
//
// The gate is sound only while NO renderer construct GROWS the text (a
// length-preserving substitution would pass the test while mapping wrongly).
// That invariant is pinned by a test in cm-table-cell-render.test.ts — if you
// add an inline construct that can render longer than its source, this mapping
// breaks silently and that test is what will tell you.

import { Facet } from "@codemirror/state";

/** A DOM caret position — the subset of `CaretPosition` / `Range` this module
 *  needs, so a test can hand-build one without a layout engine. */
export interface CaretPoint {
  readonly node: Node;
  readonly offset: number;
}

/** Injectable "what DOM position is at this viewport point" seam. The widget
 *  reads it at gesture time via `view.state.facet(...)`, matching how
 *  `quollOpenExternalSink` / `quollResourceBaseUri` are injected. The document
 *  is passed in rather than closed over so the lookup is always rooted in the
 *  widget's OWN document (a future shadow-root / multi-document host would
 *  otherwise resolve against the wrong one).
 *
 *  Throw contract: a resolver MAY throw; every call site treats a throw exactly
 *  like a `null` return (no mapping → the caller falls back to the collapsed
 *  caret). It must never take down the click handler. */
export type CaretResolver = (x: number, y: number, doc: Document) => CaretPoint | null;

/** Production resolver.
 *
 *  `caretPositionFromPoint` is the standards-track API; `caretRangeFromPoint`
 *  is the older Blink/WebKit spelling. The fallback is NOT dead code: this
 *  extension's floor is `engines.vscode ^1.94` = Chromium 124, and
 *  `caretPositionFromPoint` only shipped in Chrome 128 — so on the oldest
 *  supported VS Code the fallback IS the live path. Returns null where neither
 *  exists (happy-dom, which has no layout); that degradation is deliberate —
 *  with no resolver the widget keeps its plain collapsed-caret behaviour
 *  instead of guessing. */
export const defaultCaretResolver: CaretResolver = (x, y, doc) => {
  const fromPoint = doc.caretPositionFromPoint?.bind(doc);
  if (fromPoint !== undefined) {
    const pos = fromPoint(x, y);
    return pos === null ? null : { node: pos.offsetNode, offset: pos.offset };
  }
  const rangeFromPoint = doc.caretRangeFromPoint?.bind(doc);
  if (rangeFromPoint !== undefined) {
    const range = rangeFromPoint(x, y);
    return range === null ? null : { node: range.startContainer, offset: range.startOffset };
  }
  return null;
};

/** `combine` returns the last provider, matching `quollOpenExternalSink`'s
 *  established style (one provider in production). */
export const quollTableCaretResolver = Facet.define<CaretResolver, CaretResolver>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : defaultCaretResolver),
});

/** A pointer position resolved against one rendered table cell. */
export interface CellPoint {
  /** Absolute source offset of the cell's content start (`data-cell-from`). */
  readonly cellFrom: number;
  /** Absolute source offset of the cell's content end (`data-cell-to`). */
  readonly cellTo: number;
  /** Absolute source offset under the pointer, or `null` when this cell's
   *  rendered text is not byte-aligned with its source (inline markup,
   *  escapes, images) and an exact character mapping is not available. */
  readonly offset: number | null;
}

/** Characters of rendered text preceding `(node, offset)` within `cell`.
 *
 *  Measured with a DOM `Range` rather than a hand-rolled tree walk: a caret
 *  position may address a TEXT node (offset = character index) or an ELEMENT
 *  node (offset = CHILD INDEX), and `Range.toString()` collapses both to "the
 *  text between the cell's start and this point" with no special-casing. A
 *  hand-written walker has to get the element case, the offset-0 case and the
 *  nested-element case individually right — an earlier draft of this function
 *  got all three wrong (it returned the cell's full length for `(cell, 0)`).
 *  Returns null when the position is not addressable inside `cell` (`setEnd`
 *  throws for a detached or foreign node), which the caller treats as "no
 *  mapping". */
function textOffsetWithinCell(cell: HTMLElement, node: Node, offset: number): number | null {
  try {
    const range = cell.ownerDocument.createRange();
    range.selectNodeContents(cell);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

/** Resolve a viewport point inside `root` (a `.quoll-table-block` widget) to
 *  the cell under it plus, when byte-aligned, the exact source offset.
 *  Returns null when the point is outside the widget, outside any cell (the
 *  widget's padding/margin), on a cell missing its offset stamps, or when the
 *  resolver yields nothing / throws — every one of which the caller handles by
 *  falling back to the collapsed caret. */
export function cellPointAt(
  root: HTMLElement,
  x: number,
  y: number,
  resolve: CaretResolver
): CellPoint | null {
  let point: CaretPoint | null;
  try {
    point = resolve(x, y, root.ownerDocument);
  } catch {
    // Fail closed: an injected resolver must never take down the click handler.
    return null;
  }
  if (point === null) {
    return null;
  }
  const el =
    point.node.nodeType === Node.ELEMENT_NODE ? (point.node as Element) : point.node.parentElement;
  const cell = el?.closest("th, td") ?? null;
  // `root.contains` is the containment gate: a point over a DIFFERENT table's
  // widget (or over prose) must not be mapped through THIS widget's stamps.
  if (cell === null || !root.contains(cell)) {
    return null;
  }
  const cellEl = cell as HTMLElement;
  const cellFrom = Number(cellEl.dataset.cellFrom);
  const cellTo = Number(cellEl.dataset.cellTo);
  if (!Number.isFinite(cellFrom) || !Number.isFinite(cellTo)) {
    return null;
  }
  const rendered = cellEl.textContent ?? "";
  if (rendered.length !== cellTo - cellFrom) {
    return { cellFrom, cellTo, offset: null };
  }
  const within = textOffsetWithinCell(cellEl, point.node, point.offset);
  if (within === null) {
    return { cellFrom, cellTo, offset: null };
  }
  // No clamp: `within` is bounded by construction. `Range.toString().length`
  // cannot exceed the cell's rendered text, and the alignment gate above
  // already established `rendered.length === cellTo - cellFrom`, so
  // `cellFrom + within` is always inside `[cellFrom, cellTo]`. An offset the
  // platform considers out of range never gets this far — `setEnd` throws
  // IndexSizeError and `textOffsetWithinCell` returns null (fail closed).
  return { cellFrom, cellTo, offset: cellFrom + within };
}
