// The one contract behind Quoll's structural block widgets (table, image). A consumer
// supplies only a spec — which Lezer node to look at, how to build its block, and the
// widget for that block — and this module owns the rest: range ownership, the
// changed-range-bounded update, parse determinacy, hook failure, and reveal.
//
// Block widgets MUST come from a StateField — CodeMirror throws on a ViewPlugin
// `block: true` Decoration.replace (see CLAUDE.md block-widget invariant). Widgets are
// display-only: decorations only, never a document change → byte-identical round-trip.
//
// The field value is `{ records, decorations }`. `records` is the canonical,
// selection-independent state: a DecorationSet holding one block decoration per block that
// HAS a widget, whose range is the block range and whose `spec.structural` is the
// consumer's position-free payload. Mapping a shifted block moves its range and
// preserves both its decoration value and widget object.
// `decorations` is the selection-filtered view of it: the SAME set object whenever no
// record meets a selection line. Updates derive exclusively from the previous field value;
// the field closure holds only the diagnostic latch. EditorState is persistent — two
// transactions branching from one state never share mutable update data.
//
// 1. Ownership. A block whose node starts before `leadingFrontmatterEnd(state)` is not
//    emitted (frontmatter owns [0, fmEnd]). A built block out of document bounds, with
//    `from >= to`, not whole lines, or not containing its node, is dropped and reported as
//    `invalid-range` (the `Decoration.replace({ block: true })`, line-alignment and
//    containment preconditions live at this one call site; reveal relies on alignment).
//    fmEnd "moved" → full rebuild; see `frontmatterMoved`.
// 2. Change range / tree identity / determinacy. On a doc change, the structural guard,
//    parse frontier and frontmatter checks determine whether to rebuild in full. Otherwise,
//    map the records and filter out those meeting the changed span (changed ranges ±1 line).
//    Walk only that span, processing each matched node at most once. If a walked block
//    overlaps another walked or kept block, rebuild in full to resolve the overlap in
//    document order. A new tree without a doc change also triggers a full rebuild.
// 3. Failure → raw. The walk calls `spec.build` and `makeRecord` calls `spec.widget`,
//    each inside one try/catch. A throw leaves the block editable as raw source and
//    allows sibling blocks and the transaction to proceed. The report is latched per
//    `${name}:${arm}` and reads no properties of the thrown value. Full rebuilds drop and
//    report overlapping blocks. widget-base.ts contains DOM lifecycle failures.
// 4. Reveal. `decorations` = the records whose block does not line-overlap any selection
//    range. Records are whole lines, so the raw selection ranges suffice. Recomputed only
//    when the records or the selection line spans change; when neither did, the field
//    returns `prev` itself.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Range, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";
import {
  extractRanges,
  type Interval,
  intersects,
  lineExpandWithNeighbours,
  lineRangeOverlapsSelection,
  mergeIntervals,
  selectionLineSpansEqual,
} from "./bounded-recompute.js";
import { quollBlockReplaceZones } from "./decorations/orchestrator.js";
import { leadingFrontmatterEnd } from "./frontmatter/detect.js";
import { requiresFullBoundedRebuild } from "./structural-guard.js";
import type { QuollWidget } from "./widget-base.js";

/** One built block: its line-aligned document range plus the consumer's POSITION-FREE
 *  payload. Any position the payload needs is an offset from `from`, so a shifted block
 *  keeps the same payload object and only its range (owned by the set) moves. Also the
 *  shape `recordAt` reads back out of the set (one block interface). */
export interface BuiltBlock<B> {
  readonly from: number;
  readonly to: number;
  readonly block: B;
}

export interface StructuralBlockSpec<B> {
  /** For the failure log. */
  readonly name: string;
  /** Lezer node name that may yield a block; descendants of a match are not visited. */
  readonly node: string;
  /** The block for one matched node, or null when ineligible. Its range MUST be whole lines
   *  (`from` a line start, `to` a line end — reveal reads raw selection ranges) and MUST
   *  contain the node (`from <= node.from && node.to <= to`): liveness is judged on the
   *  block range, so a block narrower than its node would reuse a record an in-node edit
   *  invalidated. May throw: that block stays raw. */
  build(state: EditorState, node: SyntaxNodeRef): BuiltBlock<B> | null;
  /** Widget for a position-free payload. May throw: that block stays raw. */
  widget(block: B): QuollWidget;
}

declare const payload: unique symbol;
/** A DecorationSet whose `spec.structural` payloads are B — the brand is compile-time only
 *  (repo precedent: the `AbsoluteOffset` brand in `table/cell-point.ts`). */
export type StructuralRecordSet<B> = DecorationSet & { readonly [payload]?: B };

export interface StructuralBlockState<B> {
  /** Exactly the blocks that HAVE a widget (build and widget both succeeded); each
   *  decoration's `spec.structural` is its payload. */
  readonly records: StructuralRecordSet<B>;
  readonly decorations: DecorationSet;
}

/** The record whose block starts exactly at `blockFrom`, or undefined. `between` scans the
 *  set's chunk list linearly and searches inside a chunk, so a query is O(N/250 + log 250)
 *  — not an index; its whole-document fold cost is accepted by measurement
 *  (.claude/docs/PERF.md). */
export function recordAt<B>(
  records: StructuralRecordSet<B>,
  blockFrom: number
): BuiltBlock<B> | undefined {
  let hit: BuiltBlock<B> | undefined;
  records.between(blockFrom, blockFrom, (from, to, deco) => {
    if (from !== blockFrom) {
      return undefined;
    }
    hit = { from, to, block: deco.spec.structural as B };
    return false;
  });
  return hit;
}

/** Did the leading frontmatter's end move? `0` is the no-frontmatter sentinel, not a
 *  position, so it is never mapped — mapping it would send every offset-0 insertion in a
 *  frontmatter-less doc to a full rebuild. A rigid shift inside the frontmatter body maps
 *  onto the new end and stays bounded (block ranges shift uniformly); a closer that appears,
 *  vanishes or moves edits a `---` line, which the structural guard sends to full anyway. */
function frontmatterMoved(tr: Transaction, oldEnd: number, newEnd: number): boolean {
  return oldEnd === 0 || newEnd === 0 ? oldEnd !== newEnd : tr.changes.mapPos(oldEnd, 1) !== newEnd;
}

/** Does any record share a position with any selection range? Closed intervals, like
 *  `intersects`; records are whole lines, so the raw ranges need no line expansion. */
function meetsSelection(records: DecorationSet, state: EditorState): boolean {
  let met = false;
  for (const r of state.selection.ranges) {
    records.between(r.from, r.to, () => {
      met = true;
      return false;
    });
    if (met) {
      return true;
    }
  }
  return false;
}

function assemble(records: DecorationSet, state: EditorState): DecorationSet {
  if (!meetsSelection(records, state)) {
    return records;
  }
  const { ranges } = state.selection;
  let filterFrom = ranges[0].from;
  let filterTo = ranges[0].to;
  for (const r of ranges) {
    filterFrom = Math.min(filterFrom, r.from);
    filterTo = Math.max(filterTo, r.to);
  }
  return records.update({
    filter: (from, to) => !lineRangeOverlapsSelection(state.selection, from, to),
    filterFrom,
    filterTo,
  });
}

export function structuralBlockWidgets<B>(
  spec: StructuralBlockSpec<B>
): StateField<StructuralBlockState<B>> {
  const reported = new Set<string>();
  const latch = (arm: string): boolean => {
    const key = `${spec.name}:${arm}`;
    if (reported.has(key)) {
      return false;
    }
    reported.add(key);
    return true;
  };
  /** `errKind` is `typeof err` (or "invalid-range") — computing it reads nothing off `err`. */
  const report = (arm: "build" | "widget", errKind: string): void => {
    if (latch(arm)) {
      console.error("[quoll] structural block hook threw; leaving it as raw source", {
        name: spec.name,
        arm,
        errKind,
      });
    }
  };
  const reportOverlap = (): void => {
    if (latch("overlap")) {
      console.error("[quoll] structural blocks overlap; dropping the later one", {
        name: spec.name,
        arm: "overlap",
      });
    }
  };

  /** The one call site of `spec.widget`; also mints the block decoration carrying the
   *  payload. */
  const makeRecord = (block: B, from: number, to: number): Range<Decoration> | null => {
    let widget: QuollWidget;
    try {
      widget = spec.widget(block);
    } catch (err) {
      report("widget", typeof err);
      return null;
    }
    return Decoration.replace({ widget, block: true, structural: block }).range(from, to);
  };

  /** Sort a full build and drop and report each range that overlaps a kept range. */
  const sortedDisjoint = (ranges: Range<Decoration>[]): DecorationSet => {
    ranges.sort((a, b) => a.from - b.from);
    const out: Range<Decoration>[] = [];
    for (const r of ranges) {
      const last = out[out.length - 1];
      if (last === undefined || r.from > last.to) {
        out.push(r);
      } else {
        reportOverlap();
      }
    }
    return Decoration.set(out);
  };

  /** Contract 1's range preconditions. Bounds first, so `lineAt` never throws outside the
   *  `build` try/catch. */
  const validRange = (state: EditorState, b: BuiltBlock<B>, node: SyntaxNodeRef): boolean => {
    const { doc } = state;
    return (
      b.from >= 0 &&
      b.to <= doc.length &&
      b.from < b.to &&
      b.from === doc.lineAt(b.from).from &&
      b.to === doc.lineAt(b.to).to &&
      b.from <= node.from &&
      node.to <= b.to
    );
  };

  /** Walk [from, to] and append a record per eligible matched node not yet in `visited`.
   *  The one call site of `spec.build`. */
  const walk = (
    state: EditorState,
    from: number,
    to: number,
    fmEnd: number,
    visited: Set<number>,
    out: Range<Decoration>[]
  ): void => {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== spec.node) {
          return undefined;
        }
        if (visited.has(node.from) || node.from < fmEnd) {
          return false;
        }
        visited.add(node.from);
        let built: BuiltBlock<B> | null;
        try {
          built = spec.build(state, node);
        } catch (err) {
          report("build", typeof err);
          return false;
        }
        if (built === null) {
          return false;
        }
        if (!validRange(state, built, node)) {
          report("build", "invalid-range");
          return false;
        }
        const record = makeRecord(built.block, built.from, built.to);
        if (record !== null) {
          out.push(record);
        }
        return false;
      },
    });
  };

  const full = (state: EditorState): DecorationSet => {
    const out: Range<Decoration>[] = [];
    walk(state, 0, state.doc.length, leadingFrontmatterEnd(state), new Set(), out);
    return sortedDisjoint(out);
  };

  const bounded = (prev: DecorationSet, tr: Transaction, fmEnd: number): DecorationSet => {
    const raw: Interval[] = [];
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      raw.push(lineExpandWithNeighbours(tr.state, fromB, toB));
    });
    const span = mergeIntervals(raw);
    const added: Range<Decoration>[] = [];
    const visited = new Set<number>();
    for (const iv of span) {
      walk(tr.state, iv.from, iv.to, fmEnd, visited, added);
    }
    // Every record ends before the span (so before the first change, where A and B positions
    // agree): none moves, none is filtered. Returning `prev` keeps the set — and everything
    // derived from it — shared instead of re-allocating it on each keystroke below the last block.
    if (added.length === 0 && prev.iter(span[0].from).value === null) {
      return prev;
    }
    const kept = prev.map(tr.changes).update({
      filter: (from, to) => from < to && !intersects(span, from, to),
      filterFrom: span[0].from,
      filterTo: span[span.length - 1].to,
    });
    // A walked block can extend beyond the span into a kept block.
    added.sort((a, b) => a.from - b.from);
    for (const [index, record] of added.entries()) {
      if (index > 0 && record.from <= added[index - 1].to) {
        return full(tr.state);
      }
      let overlaps = false;
      kept.between(record.from, record.to, () => {
        overlaps = true;
        return false;
      });
      if (overlaps) {
        return full(tr.state);
      }
    }
    return added.length === 0 ? kept : kept.update({ add: added, sort: true });
  };

  const nextRecords = (prev: DecorationSet, tr: Transaction): DecorationSet => {
    if (tr.docChanged) {
      const newEnd = leadingFrontmatterEnd(tr.state);
      if (
        frontmatterMoved(tr, leadingFrontmatterEnd(tr.startState), newEnd) ||
        requiresFullBoundedRebuild(tr)
      ) {
        return full(tr.state);
      }
      return bounded(prev, tr, newEnd);
    }
    if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return full(tr.state); // the parser reached further: a block may have appeared
    }
    return prev;
  };

  return StateField.define<StructuralBlockState<B>>({
    create: (state) => {
      const records = full(state);
      return { records, decorations: assemble(records, state) };
    },
    update: (prev, tr) => {
      const records = nextRecords(prev.records, tr);
      if (records === prev.records && selectionLineSpansEqual(tr.startState, tr.state)) {
        return prev;
      }
      const decorations = assemble(records, tr.state);
      if (records === prev.records && decorations === prev.decorations) {
        return prev;
      }
      return { records, decorations };
    },
    provide: (f) => [
      EditorView.decorations.from(f, (s) => s.decorations),
      quollBlockReplaceZones.from(f, (s) => extractRanges(s.decorations)),
    ],
  });
}
