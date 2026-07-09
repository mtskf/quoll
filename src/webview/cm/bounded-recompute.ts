// Small pure leaf helpers shared by the block-widget StateFields that maintain
// their DecorationSet / model list with a changed-range-bounded recompute
// (image/image-field.ts, table/table-field.ts, table/table-skeleton.ts — see
// PERF.md). These were byte-identical copies in each file; they live here as ONE
// implementation so the copies cannot drift.
//
// SCOPE: only the small, self-contained leaf helpers are shared. A full
// `defineBlockWidgetField` FACTORY over `buildAll` was deliberately REJECTED as
// leaky — the table field's global ordinal makes bounding it genuinely different
// from the image field's widget-reuse — and is gated on a future third consumer
// (the list block widget). See the recorded decision in
// .claude/docs/TODO-archive.md. Do NOT grow this module into that factory.
//
// The three fold-gutter fields (fold/index.ts), the callout marker-conceal field
// (decorations/callout-marker-conceal.ts), and fenced-code collapse
// (fenced-code/fenced-code-collapse.ts) now reuse the interval helpers here
// (fenced-code keeps its own narrower structural guard local — see
// structural-guard.ts). The Markdown-structural reparse guard
// (`touchesStructuralReparse`) + its block-boundary helpers (`isBlankLine`,
// `expandToEnclosingBlock`) live in the sibling structural-guard.ts, which imports
// `Interval` from here.

import type { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

export interface Interval {
  from: number;
  to: number;
}

/** Line-expand [from,to] AND pull in one neighbour line on each side (G1: a
 *  blank-line toggle ADJACENT to a block re-groups its parent and flips its
 *  eligibility WITHOUT touching the block's own bytes). */
export function lineExpandWithNeighbours(state: EditorState, from: number, to: number): Interval {
  const len = state.doc.length;
  const lo = state.doc.lineAt(Math.max(0, Math.min(from, len)));
  const hi = state.doc.lineAt(Math.max(0, Math.min(to, len)));
  const prevFrom = lo.from > 0 ? state.doc.lineAt(lo.from - 1).from : lo.from;
  const nextTo = hi.to < len ? state.doc.lineAt(hi.to + 1).to : hi.to;
  return { from: prevFrom, to: nextTo };
}

/** Coalesce overlapping/adjacent intervals (closed-interval merge) into a
 *  minimal, from-sorted list. Returns fresh objects (never aliases the input). */
export function mergeIntervals(intervals: Interval[]): Interval[] {
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

/** Does [from,to] intersect ANY interval? Closed-interval overlap. */
export function intersects(intervals: readonly Interval[], from: number, to: number): boolean {
  for (const iv of intervals) {
    if (from <= iv.to && iv.from <= to) {
      return true;
    }
  }
  return false;
}

/** True iff any range in `selection` overlaps the inclusive `[from, to]` line
 *  interval. `from`/`to` are line-aligned by the block fields' `buildAll`, so
 *  the closed interval catches caret-at-boundary cases half-open would miss.
 *  A `SelectionRange` is structurally `{ from, to }`, so this is just
 *  `intersects` over the selection's ranges. */
export function lineRangeOverlapsSelection(
  selection: EditorSelection,
  from: number,
  to: number
): boolean {
  return intersects(selection.ranges, from, to);
}

/** Do the two states' selections resolve to the SAME set of line spans? The
 *  selection-only fast path: when true, a per-block line-overlap verdict cannot
 *  have changed, so the field can return `prev` unchanged (no tree walk). */
export function selectionLineSpansEqual(prevState: EditorState, newState: EditorState): boolean {
  const prev = prevState.selection;
  const curr = newState.selection;
  if (prev.ranges.length !== curr.ranges.length) {
    return false;
  }
  for (let i = 0; i < curr.ranges.length; i++) {
    const a = prev.ranges[i];
    const b = curr.ranges[i];
    if (
      prevState.doc.lineAt(a.from).from !== newState.doc.lineAt(b.from).from ||
      prevState.doc.lineAt(a.to).to !== newState.doc.lineAt(b.to).to
    ) {
      return false;
    }
  }
  return true;
}

/** Flatten a DecorationSet to its `{from,to}` ranges in document order — the
 *  shape the quollBlockReplaceZones facet publishes. */
export function extractRanges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}
