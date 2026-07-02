// A bounded-maintained, document-ordered list of EVERY Lezer `Table` node as a
// renderable table MODEL — `{from,to}` (the node range, produced by a full
// `syntaxTree(state).iterate()` via `collectTableRanges`) PLUS the line-snapped
// block range, the per-node CRLF-normalised source slice, and the cached
// `parseTable` result.
// `tableBlockField`'s `buildAll` reads THIS field instead of re-walking the tree
// AND re-parsing every table per keystroke (~5 ms/MB whole-tree materialisation
// + O(tables) `parseTable` — see PERF.md). The list includes NON-emitting `Table`
// nodes (blockquote/list/indented "tables" that `parseTable` rejects → `table:
// null`) so that `tableBlockField` can derive a stable, document-ordered index
// over all Table nodes via the array's index + length.
//
// Bounded update mirrors imageBlockField's proven shape (PERF.md): reuse models
// OUTSIDE an `extendedSpan` (their node range + block range mapped through
// `tr.changes`, slice + parse reused verbatim), re-walk + re-parse the tree only
// INSIDE it. The parse + line-snap ride on the SAME liveness decision the ranges
// already use, so they inherit its soundness: Guards G1 (±1 line — a blank-line
// toggle adjacent to a table merges/splits it or (un)absorbs a trailing
// paragraph WITHOUT touching the table's own bytes; lezer also overshoots a
// table's `to` into a following non-blank paragraph —
// [[quoll-lezer-table-to-overshoots-trailing-line]]); G2 (`!syntaxTreeAvailable`
// → full walk; the later background-parse publication, a `!docChanged`
// tree-identity change, full-walks again to self-heal). Soundness (bounded ≡
// fullWalk, ranges AND parses) is pinned by cm-table-skeleton.test.ts.

import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { type EditorState, StateField, type Transaction } from "@codemirror/state";
import { parseTable, type Table } from "../../../markdown/table/index.js";
import { collectTableRanges } from "./table-ranges.js";

export interface TableModel {
  /** Lezer `Table` node range — the bounded-reuse identity, re-walk dedup key,
   *  and document-order position within the array. */
  from: number;
  to: number;
  /** Whole-line-snapped block range — the block widget's `docFrom`..end. Block
   *  widgets must cover complete lines; precomputed here so `buildAll` does no
   *  per-keystroke `lineAt` over every table. */
  blockFrom: number;
  blockTo: number;
  /** Per-node source slice, CRLF-normalised to LF (so cell `raw` strings cannot
   *  carry an embedded `\r` the DOM textNode would render as stray whitespace).
   *  The widget's eq() key; the input the cached `table` was parsed from. */
  slice: string;
  /** Cached parse, or `null` for a non-emitting `Table` node (blockquote/list/
   *  indented "table" that `parseTable` rejects). Still occupies an ordinal slot
   *  in the document-order array for stable index accounting. */
  table: Table | null;
}

interface Interval {
  from: number;
  to: number;
}

/** Build one model from a `Table` node range: per-node slice (CRLF→LF) + parse +
 *  whole-line snap. Pure reader of the passed state's lazy doc. */
function buildModel(state: EditorState, nodeFrom: number, nodeTo: number): TableModel {
  const len = state.doc.length;
  // Per-node slice — O(table-bytes). Never materialise the full doc. CRLF→LF for
  // the widget's working slice (source doc keeps CRLF; only this copy normalises).
  const slice = state.sliceDoc(nodeFrom, nodeTo).replace(/\r\n?/g, "\n");
  const table = parseTable(slice, 0, slice.length);
  // Snap to whole-line boundaries — `block: true` widgets must cover complete
  // lines. Defensive: Lezer's Table node range usually IS line-aligned, but
  // doc-final-no-newline and partial-tree edges may not be.
  const startLine = state.doc.lineAt(nodeFrom);
  const endLine = state.doc.lineAt(Math.min(nodeTo, len));
  return {
    from: nodeFrom,
    to: nodeTo,
    blockFrom: startLine.from,
    blockTo: endLine.to,
    slice,
    table,
  };
}

/** Every `Table` node as a model, in document order — the unbounded reference
 *  used by the field's `create`/self-heal/G2 paths AND by `buildAll`'s fallback
 *  when the field is absent (tests). Lazy reader of `syntaxTree(state)`. */
export function tableModels(state: EditorState): TableModel[] {
  return collectTableRanges(syntaxTree(state)).map((r) => buildModel(state, r.from, r.to));
}

/** Line-expand [from,to] AND pull in one neighbour line on each side (G1). */
function lineExpandWithNeighbours(state: EditorState, from: number, to: number): Interval {
  const len = state.doc.length;
  const lo = state.doc.lineAt(Math.max(0, Math.min(from, len)));
  const hi = state.doc.lineAt(Math.max(0, Math.min(to, len)));
  const prevFrom = lo.from > 0 ? state.doc.lineAt(lo.from - 1).from : lo.from;
  const nextTo = hi.to < len ? state.doc.lineAt(hi.to + 1).to : hi.to;
  return { from: prevFrom, to: nextTo };
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) {
    return [];
  }
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const out: Interval[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.from <= last.to) {
      last.to = Math.max(last.to, cur.to);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

function extendedSpan(tr: Transaction): Interval[] {
  const raw: Interval[] = [];
  tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
    raw.push(lineExpandWithNeighbours(tr.state, fromB, toB)); // G1
  });
  return mergeIntervals(raw);
}

function intersects(span: Interval[], from: number, to: number): boolean {
  for (const s of span) {
    if (from <= s.to && s.from <= to) {
      return true;
    }
  }
  return false;
}

function boundedUpdate(
  prev: readonly TableModel[],
  tr: Transaction,
  span: Interval[]
): TableModel[] {
  const byFrom = new Map<number, TableModel>();
  // Reuse models OUTSIDE the span: map the node range AND the block range; reuse
  // slice + parse verbatim. Liveness has a PRIMARY and an AUXILIARY guard:
  //   - PRIMARY: `!intersects(span, nf, nt)` — the new-range span guard. The
  //     `extendedSpan` (changed range ±1 line, G1) is centred on the change in
  //     NEW-doc coords, so any table whose bytes changed OR whose structure could
  //     flip (a blank-line toggle merging/splitting it, lezer trailing overshoot)
  //     has its mapped range intersect the span → re-walked + re-parsed. This is
  //     what makes parse-reuse sound: a reused parse's input slice is its node
  //     bytes, and G1/G2 already guarantee those bytes (and the node range) are
  //     unchanged for non-intersecting tables — node-range change ⇒ slice change
  //     ⇒ never a silent stale reuse.
  //   - AUXILIARY: `!touched` (old-range `touchesRange`) — a conservative
  //     belt-and-suspenders early-out in OLD coords. CM's `touchesRange` is
  //     boundary-inclusive, so for table geometries both guards are mutually
  //     shadowing: a blank-line deletion that merges two tables is adjacent to the
  //     second table's start → `touched=true` there, AND its mapped range falls
  //     inside the ±1-line span. Neither guard is independently isolable by a
  //     table geometry test; both are retained for belt-and-suspenders safety and
  //     consistency with `imageBlockField` (where the ±1 span IS load-bearing).
  for (const m of prev) {
    const touched = tr.changes.touchesRange(m.from, m.to) !== false;
    const nf = tr.changes.mapPos(m.from, 1);
    const nt = tr.changes.mapPos(m.to, -1);
    if (!touched && !intersects(span, nf, nt)) {
      byFrom.set(nf, {
        from: nf,
        to: nt,
        blockFrom: tr.changes.mapPos(m.blockFrom, 1),
        blockTo: tr.changes.mapPos(m.blockTo, -1),
        slice: m.slice,
        table: m.table,
      });
    }
  }
  // Re-walk + re-parse `Table` nodes INSIDE each span interval (re-walk wins on
  // same node `from`).
  const tree = syntaxTree(tr.state);
  for (const s of span) {
    for (const r of collectTableRanges(tree, s.from, s.to)) {
      byFrom.set(r.from, buildModel(tr.state, r.from, r.to));
    }
  }
  return [...byFrom.values()].sort((a, b) => a.from - b.from);
}

// NOTE: legacy name — this field now carries full `TableModel[]` (range + block
// range + slice + parse), not a bare node-range "skeleton". The name is kept to
// avoid churn across editor.ts / index.ts / the table-field tests
// that import it; see the header doc for what it holds.
export const tableSkeletonField = StateField.define<readonly TableModel[]>({
  create: (state) => tableModels(state),
  update: (prev, tr) => {
    if (tr.docChanged) {
      if (!syntaxTreeAvailable(tr.state, tr.state.doc.length)) {
        return tableModels(tr.state); // G2
      }
      return boundedUpdate(prev, tr, extendedSpan(tr));
    }
    if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return tableModels(tr.state); // background-parse publication self-heal
    }
    return prev; // selection-only / no-op: tree unchanged → models unchanged
  },
});
