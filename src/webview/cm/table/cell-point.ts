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
// Rendered-to-source mapping: a cell holding `**bold**` (8 source bytes)
// renders as `bold` (4 characters), so a DOM character offset is NOT addable to
// the cell's source offset. The RENDERER answers that — cell-render.ts emits a
// `CellSourceMap` (rendered run → source span, plus the markup each run owns)
// in the same pass that emits the DOM, and this module measures the rendered
// offset with a DOM `Range` and looks it up. Where the map has no exact answer
// — a boundary beside a construct that renders NO text, where both sides
// measure the same rendered offset — `offset` is `null` and the caller snaps to
// a cell boundary rather than inventing a position.
//
// This replaced a LENGTH-EQUALITY gate (`renderedText.length === cellTo -
// cellFrom` → map 1:1, else null). It was wrong in both directions: every cell
// holding any inline markup lost exact mapping, and it rested on an unwritten
// contract — "no construct may render LONGER than its source" — whose only
// guard was a hand-maintained CASES list, so a future construct that GREW text
// while preserving total length would have passed the gate and mapped every
// offset wrongly, silently. The map has no such contract to break.
//
// Staleness: the map is keyed on the cell ELEMENT, and `stampRow` re-points the
// offset stamps on a positional shift WITHOUT re-rendering, so a map must be
// proven current before it is trusted. Both halves are checked —
// `sourceLength` against the stamps and `renderedText` against the cell's live
// `textContent`. Lengths alone would let a same-length stale map through; the
// text comparison is the one check a coincidence of lengths cannot fool.

import { Facet } from "@codemirror/state";

import {
  asRenderedOffset,
  getCellSourceMap,
  type RenderedOffset,
  sourceOffsetAt,
} from "./cell-source-map.js";

/** A DOM caret position — the subset of `CaretPosition` / `Range` this module
 *  needs, so a test can hand-build one without a layout engine. */
export interface CaretPoint {
  readonly node: Node;
  readonly offset: number;
}

/** Injectable "what DOM position is at this viewport point" seam, read at
 *  gesture time via `view.state.facet(...)` (the injection SHAPE of
 *  `quollOpenExternalSink` / `quollResourceBaseUri`). NOTE: unlike those two,
 *  nothing in `src/` provides this facet — production runs on the combine's
 *  empty-provider default (`defaultCaretResolver`) and the `.of(...)` seam
 *  exists for tests. The document is passed in rather than closed over so the
 *  lookup is always rooted in the widget's OWN document (a future
 *  multi-document host — a second webview document or an iframe — would
 *  otherwise resolve against the wrong one).
 *
 *  Throw contract: a resolver MAY throw, and MAY return a malformed value;
 *  every call site treats either exactly like a `null` return (no mapping →
 *  the caller falls back to the collapsed caret). It must never take down the
 *  click handler. */
export type CaretResolver = (x: number, y: number, doc: Document) => CaretPoint | null;

/** The caret-from-point capability as it ACTUALLY exists at runtime. lib.dom
 *  declares both methods as REQUIRED members of `Document`, which is false on
 *  our floor (Chromium 124 has no `caretPositionFromPoint`) and in happy-dom
 *  (neither exists). Restating them optional makes the type describe the real
 *  platform minimum, so the `?.` guards and the fallback arm below read as
 *  reachable code rather than as dead defensive noise against a `Document`
 *  whose type promises both. It is documentation, NOT enforcement: this repo
 *  sets neither `allowUnreachableCode: false` nor any equivalent, so typing
 *  against `Document` would narrow the fallback to `never` without producing a
 *  single diagnostic — what protects the Chromium-124 path from a simplify pass
 *  is cm-table-cell-point.test.ts's `defaultCaretResolver` block, not tsc.
 *  `Document` is assignable WITHOUT a cast. */
interface CaretApiHost {
  readonly caretPositionFromPoint?: (x: number, y: number) => CaretPosition | null;
  readonly caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/** Production resolver.
 *
 *  `caretPositionFromPoint` is the standards-track API; `caretRangeFromPoint`
 *  is the older Blink/WebKit spelling. The fallback is NOT dead code: this
 *  extension's floor is `engines.vscode ^1.94` = Chromium 124, and
 *  `caretPositionFromPoint` only shipped in Chrome 128 — so on the oldest
 *  supported VS Code the fallback IS the live path. Returns null where neither
 *  exists (happy-dom, which has no layout); that degradation is deliberate —
 *  with no resolver the widget keeps its plain collapsed-caret behaviour
 *  instead of guessing. `.bind(doc)` because both are Document methods that
 *  throw "illegal invocation" when called with a detached receiver. */
export const defaultCaretResolver: CaretResolver = (x, y, doc) => {
  const api: CaretApiHost = doc;
  const fromPoint = api.caretPositionFromPoint?.bind(doc);
  if (fromPoint !== undefined) {
    const pos = fromPoint(x, y);
    return pos === null ? null : { node: pos.offsetNode, offset: pos.offset };
  }
  const rangeFromPoint = api.caretRangeFromPoint?.bind(doc);
  if (rangeFromPoint !== undefined) {
    const range = rangeFromPoint(x, y);
    return range === null ? null : { node: range.startContainer, offset: range.startOffset };
  }
  return null;
};

/** `combine` returns the last provider (the `quollOpenExternalSink` style), and
 *  its EMPTY arm is the LIVE production path — see CaretResolver above; nothing
 *  in `src/` calls `.of(...)`. Do not delete that arm as unreachable. */
export const quollTableCaretResolver = Facet.define<CaretResolver, CaretResolver>({
  combine: (values) => (values.length > 0 ? values[values.length - 1] : defaultCaretResolver),
});

declare const absoluteOffsetBrand: unique symbol;
/** An LF-internal offset into the WHOLE document — what `data-cell-from`
 *  carries and what a CodeMirror selection is dispatched with. Declared HERE
 *  rather than in cell-source-map.ts because the map speaks only its own
 *  cell-relative space; this is the space the DOM stamps and the editor use,
 *  and this module is the only one that converts between the two. */
export type AbsoluteOffset = number & { readonly [absoluteOffsetBrand]: true };

/** THE constructor of an {@link AbsoluteOffset} — a cast, not a guard (see the
 *  brand note in cell-source-map.ts). Both call sites below mint only a value
 *  that `Number.isSafeInteger` has just accepted. */
export function asAbsoluteOffset(value: number): AbsoluteOffset {
  return value as AbsoluteOffset;
}

/** A pointer position resolved against one rendered table cell. */
export interface CellPoint {
  /** Absolute source offset of the cell's content start (`data-cell-from`). */
  readonly cellFrom: AbsoluteOffset;
  /** Absolute source offset of the cell's content end (`data-cell-to`). */
  readonly cellTo: AbsoluteOffset;
  /** Absolute source offset under the pointer, or `null` when this cell has no
   *  exact mapping for it — no current source map (an unrendered or
   *  hand-built cell), or a boundary the map cannot place because invisible
   *  source (a live image) sits on one side of it. */
  readonly offset: AbsoluteOffset | null;
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
 *  Returns null when `setEnd` throws — in practice an out-of-range `offset`
 *  (IndexSizeError), which the caller treats as "no mapping" rather than
 *  clamping to a position the pointer was never at.
 *
 *  A node from OUTSIDE `cell` does NOT throw, and does not necessarily collapse
 *  either: `setEnd` re-roots the range's START only when the new end is in a
 *  different root/document or compares BEFORE the current start (DOM spec
 *  "set the end" step 4; happy-dom Range.setEnd mirrors it). A same-document
 *  node lying AFTER the cell fails both conditions, so the start stays at the
 *  cell's first character and the result EXCEEDS the cell's text length — a
 *  rendered offset for a point the pointer was never at, which `sourceOffsetAt`
 *  would refuse as out of range but only by luck, since a SHORTER overshoot
 *  inside the cell's own text would map silently. It cannot happen here,
 *  because the caller derives `cell` from this very node
 *  (`closest("th, td")`), which makes `node` the cell itself or a descendant of
 *  it. The bound is a property of that derivation, not of `setEnd`. Any future
 *  caller that resolves `cell` some other way owes this function a clamp. */
function textOffsetWithinCell(cell: Element, node: Node, offset: number): RenderedOffset | null {
  try {
    const range = cell.ownerDocument.createRange();
    range.selectNodeContents(cell);
    range.setEnd(node, offset);
    return asRenderedOffset(range.toString().length);
  } catch {
    return null;
  }
}

/** `null` unless the attribute is present and a non-negative INTEGER — the
 *  shape CellPoint's arithmetic and `view.dispatch({selection})` both assume.
 *  `Number.isFinite` alone would admit a negative and a fraction, and `Number`
 *  maps `""` to 0.
 *
 *  This is the ONLY gate between a DOM stamp and a dispatched position, for the
 *  drag path here and for table-widget.ts's caret path alike, because
 *  CodeMirror does not re-check: `checkSelection` (@codemirror/state) tests
 *  `range.to > doc.length` and nothing else, so `NaN`, a negative, and a
 *  fraction all pass validation and land a silently broken selection that no
 *  try/catch can observe. `Element`, not `HTMLElement`: `getAttribute` lives on
 *  Element and this module stays realm-independent (no `instanceof`). */
export function stampedOffset(cell: Element, name: string): AbsoluteOffset | null {
  const raw = cell.getAttribute(name);
  // Decimal digits only. `Number` alone accepts "" (→ 0), " 78 ", "-5", "78.5"
  // and "7e2"; the widget only ever writes `String(nodeFrom + cell.from)`, so
  // digits ARE the contract. `isSafeInteger` then rejects a digit string long
  // enough to lose precision.
  if (raw === null || !/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? asAbsoluteOffset(value) : null;
}

/** Resolve a viewport point inside `root` (a `.quoll-table-block` widget) to
 *  the cell under it plus, when the cell's (current) source map places the
 *  rendered boundary exactly, the source offset.
 *  Returns null when the point is outside the widget, outside any cell (the
 *  widget's padding/margin), on a cell whose offset stamps are missing or
 *  malformed, or when the resolver yields nothing / throws / answers with a
 *  malformed value — every one of which the caller handles by falling back to
 *  the collapsed caret. */
export function cellPointAt(
  root: HTMLElement,
  x: number,
  y: number,
  resolve: CaretResolver
): CellPoint | null {
  // Fail closed around the WHOLE body, not just the `resolve` call. The facet
  // has no out-of-repo callers (the barrel is internal; only tests call
  // `.of(...)`), and `.of(...)` does type-check what it is handed — the test
  // that exercises a malformed answer needs a cast to get one past it. What
  // the facet erases is PROVENANCE: by the time the value arrives here it is
  // just a `CaretResolver`, with nothing tying it to the declaration that was
  // checked, so a `{ node: null }` answer throws on the very next line and
  // would take the widget's DOM listener with it.
  // Catching here is not equivalent to the two internal failure modes below —
  // those answer `{ …, offset: null }` (keep the cell, snap to its boundary),
  // this answers `null` (no cell at all, caller falls back to the collapsed
  // caret). It is the strictly weaker answer, which is the right one when the
  // failure is "we cannot trust anything this resolver told us". The function
  // is side-effect-free, so swallowing loses nothing but the exception.
  try {
    const point = resolve(x, y, root.ownerDocument);
    if (point === null) {
      return null;
    }
    const el =
      point.node.nodeType === Node.ELEMENT_NODE
        ? (point.node as Element)
        : point.node.parentElement;
    const cell = el?.closest("th, td") ?? null;
    // `root.contains` is the containment gate: a point over a DIFFERENT table's
    // widget (or over prose) must not be mapped through THIS widget's stamps.
    if (cell === null || !root.contains(cell)) {
      return null;
    }
    const cellFrom = stampedOffset(cell, "data-cell-from");
    const cellTo = stampedOffset(cell, "data-cell-to");
    if (cellFrom === null || cellTo === null || cellTo < cellFrom) {
      return null;
    }
    const within = textOffsetWithinCell(cell, point.node, point.offset);
    if (within === null) {
      return { cellFrom, cellTo, offset: null };
    }
    // Snapshot check — the map is only usable while it still describes BOTH
    // this source span and this DOM. `stampRow` moves the stamps without
    // re-rendering, and `patchRow` re-renders in place, so either half can move
    // under a map that outlived it.
    //
    // `cellTo - cellFrom` is an absolute-space DELTA, which is a LENGTH and so
    // comparable with the cell-relative `sourceLength`. The brands cannot
    // certify this one: subtraction erases them, exactly as addition does.
    const map = getCellSourceMap(cell);
    if (
      map === null ||
      map.sourceLength !== cellTo - cellFrom ||
      map.renderedText !== (cell.textContent ?? "")
    ) {
      return { cellFrom, cellTo, offset: null };
    }
    const relative = sourceOffsetAt(map, within);
    // Same gate `stampedOffset` applies to the DOM stamps, for the same reason:
    // this is the OTHER input to the dispatched position, and `sourceOffsetAt`
    // validates `within` but trusts every number inside `map` unconditionally.
    // The clamp below cannot stand in for it — `Math.min`/`Math.max` propagate
    // a fraction and a `NaN` untouched — and CodeMirror's `checkSelection`
    // tests only `range.to > doc.length`.
    if (relative === null || !Number.isSafeInteger(relative)) {
      return { cellFrom, cellTo, offset: null };
    }
    // The clamp is a belt to the snapshot check's braces, against a RANGE
    // error rather than a shape one. `sourceOffsetAt` already answers within
    // `[0, map.sourceLength]` and the check just proved `sourceLength ===
    // cellTo - cellFrom`, so this cannot fire today — but a position outside
    // the cell is exactly the silently-wrong selection this module exists to
    // prevent.
    //
    // This is the ONE sanctioned crossing from the cell-relative source space
    // into the absolute one — the addition cell-source-map.ts's header warns
    // about, legal here and only here because the two checks above proved the
    // map describes THIS cell's source and `relative` is a safe integer. Both
    // `+` and `Math.min` erase the brand (TS types either as plain `number`),
    // so the mint is what re-asserts the space, and its absence anywhere else
    // is a compile error.
    const offset = asAbsoluteOffset(Math.min(Math.max(cellFrom + relative, cellFrom), cellTo));
    return { cellFrom, cellTo, offset };
  } catch {
    return null;
  }
}
