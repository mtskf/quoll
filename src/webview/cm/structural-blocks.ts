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
// selection-independent state: one record per block that HAS a widget, sorted by
// `block.from`, each carrying its own decoration (precedent: collapse/line-collapse-field.ts).
// `decorations` is the selection-filtered view of it. Updates derive exclusively from the
// previous field value; the field closure holds only the diagnostic latch. EditorState is
// persistent — two transactions branching from one state never share mutable update data.
//
// 1. Ownership. A block whose node starts before `leadingFrontmatterEnd(state)` is not
//    emitted (frontmatter owns [0, fmEnd]). A built block with `from >= to`, or one that
//    does not contain its node, is dropped (the `Decoration.replace({ block: true })`
//    precondition and the containment precondition live at this one call site). fmEnd
//    "moved" → full rebuild; see `frontmatterMoved`.
// 2. Change range / tree identity / determinacy. On a doc change,
//    `requiresFullBoundedRebuild` (../structural-guard.ts — the single home of every
//    full-rebuild reason) → full; otherwise every prev record whose block is untouched and
//    outside the span (changed ranges ±1 line) is reused — the SAME record when unmoved,
//    else rebased through `makeRecord` — and only the span is re-walked, each matched node
//    processed at most once per rebuild (`visited`). Reused records and walked nodes are
//    disjoint by construction: the reuse guard drops every record whose mapped range meets
//    the span, every walked node meets the span, and a block contains its node. No doc
//    change but a new tree (the parser reached further) → full. Else prev.
// 3. Failure → raw. `spec.build` is called only in the walk and `spec.widget` only in
//    `makeRecord`, each inside one try/catch. A throw → no record: the raw source stays
//    editable, sibling blocks, the transaction and edit-sync proceed. A dropped block is
//    retried only when a changed span touches it or a full rebuild happens. The report is
//    latched once per `${name}:${arm}` and reads NO property of `err` (a throwing getter
//    inside the catch would escape `StateField.update` — the failure this arm contains;
//    same rule as widget-base.ts `reportOnce`). DOM lifecycle failures stay owned by
//    widget-base.ts.
// 4. Reveal. `decorations` = the record decorations whose block does not line-overlap any
//    selection range. Recomputed only when the records or the selection line spans change;
//    when neither did, the field returns `prev` itself.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateField, type Transaction } from "@codemirror/state";
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

/** A line-aligned document range one consumer owns as a block widget. Any other
 *  position a consumer stores is an offset from `from`, so the contract can
 *  rebase a reused block by a uniform shift ({ ...block, from, to }). */
export interface StructuralBlock {
  readonly from: number;
  readonly to: number;
}

export interface StructuralBlockSpec<B extends StructuralBlock> {
  /** For the failure log. */
  readonly name: string;
  /** Lezer node name that may yield a block; descendants of a match are not visited. */
  readonly node: string;
  /** The block for one matched node, or null when ineligible. It MUST contain the node
   *  (`from <= node.from && node.to <= to`): liveness is judged on the block range, so a block
   *  narrower than its node would reuse a record an in-node edit invalidated. May throw: that block stays raw. */
  build(state: EditorState, node: SyntaxNodeRef): B | null;
  /** Widget for a block object. May throw: that block stays raw. */
  widget(block: B): QuollWidget;
}

export interface StructuralBlockRecord<B extends StructuralBlock> {
  readonly block: B;
  readonly deco: Decoration;
}

export interface StructuralBlockState<B extends StructuralBlock> {
  /** Exactly the blocks that HAVE a widget (build and widget both succeeded), sorted by `block.from`. */
  readonly records: readonly StructuralBlockRecord<B>[];
  readonly decorations: DecorationSet;
}

/** The record whose block starts exactly at `blockFrom`, or undefined. A binary search:
 *  `records` is sorted by `block.from` (Contract 2). */
export function recordAt<B extends StructuralBlock>(
  records: readonly StructuralBlockRecord<B>[],
  blockFrom: number
): StructuralBlockRecord<B> | undefined {
  let lo = 0;
  let hi = records.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const from = records[mid].block.from;
    if (from === blockFrom) {
      return records[mid];
    }
    if (from < blockFrom) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return undefined;
}

/** Did the leading frontmatter's end move? `0` is the no-frontmatter sentinel, not a
 *  position, so it is never mapped — mapping it would send every offset-0 insertion in a
 *  frontmatter-less doc to a full rebuild. A rigid shift inside the frontmatter body maps
 *  onto the new end and stays bounded (blocks rebase uniformly); a closer that appears,
 *  vanishes or moves edits a `---` line, which the structural guard sends to full anyway. */
function frontmatterMoved(tr: Transaction, oldEnd: number, newEnd: number): boolean {
  return oldEnd === 0 || newEnd === 0 ? oldEnd !== newEnd : tr.changes.mapPos(oldEnd, 1) !== newEnd;
}

/** Records in `from` order with any block that overlaps an earlier one dropped. Reused
 *  and walked records are disjoint by construction (header, Contract 2), so the drop is a
 *  backstop for a spec whose blocks overlap each other: overlapping block replaces would
 *  otherwise reach `Decoration.set`. */
function sortedDisjoint<B extends StructuralBlock>(
  records: StructuralBlockRecord<B>[]
): StructuralBlockRecord<B>[] {
  records.sort((a, b) => a.block.from - b.block.from);
  const out: StructuralBlockRecord<B>[] = [];
  for (const r of records) {
    const last = out[out.length - 1];
    if (last === undefined || r.block.from > last.block.to) {
      out.push(r);
    }
  }
  return out;
}

function assemble<B extends StructuralBlock>(
  records: readonly StructuralBlockRecord<B>[],
  state: EditorState
): DecorationSet {
  const ranges = [];
  for (const r of records) {
    if (!lineRangeOverlapsSelection(state.selection, r.block.from, r.block.to)) {
      ranges.push(r.deco.range(r.block.from, r.block.to));
    }
  }
  // Records are sorted and disjoint, so the ranges are too: no sort requested.
  return Decoration.set(ranges);
}

export function structuralBlockWidgets<B extends StructuralBlock>(
  spec: StructuralBlockSpec<B>
): StateField<StructuralBlockState<B>> {
  const reported = new Set<string>();
  /** `errKind` is `typeof err` (or "invalid-range") — computing it reads nothing off `err`. */
  const report = (arm: "build" | "widget", errKind: string): void => {
    const key = `${spec.name}:${arm}`;
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    console.error("[quoll] structural block hook threw; leaving it as raw source", {
      name: spec.name,
      arm,
      errKind,
    });
  };

  /** The one call site of `spec.widget`; also mints the block decoration. */
  const makeRecord = (block: B): StructuralBlockRecord<B> | null => {
    let widget: QuollWidget;
    try {
      widget = spec.widget(block);
    } catch (err) {
      report("widget", typeof err);
      return null;
    }
    return { block, deco: Decoration.replace({ widget, block: true }) };
  };

  /** Walk [from, to] and append a record per eligible matched node not yet in `visited`.
   *  The one call site of `spec.build`. */
  const walk = (
    state: EditorState,
    from: number,
    to: number,
    fmEnd: number,
    visited: Set<number>,
    out: StructuralBlockRecord<B>[]
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
        let block: B | null;
        try {
          block = spec.build(state, node);
        } catch (err) {
          report("build", typeof err);
          return false;
        }
        if (block === null) {
          return false;
        }
        if (block.from >= block.to || block.from > node.from || node.to > block.to) {
          report("build", "invalid-range");
          return false;
        }
        const record = makeRecord(block);
        if (record !== null) {
          out.push(record);
        }
        return false;
      },
    });
  };

  const full = (state: EditorState): StructuralBlockRecord<B>[] => {
    const out: StructuralBlockRecord<B>[] = [];
    walk(state, 0, state.doc.length, leadingFrontmatterEnd(state), new Set(), out);
    return sortedDisjoint(out);
  };

  const bounded = (
    prev: readonly StructuralBlockRecord<B>[],
    tr: Transaction,
    fmEnd: number
  ): readonly StructuralBlockRecord<B>[] => {
    const raw: Interval[] = [];
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => {
      raw.push(lineExpandWithNeighbours(tr.state, fromB, toB));
    });
    const span = mergeIntervals(raw);
    let changed = false;
    const next: StructuralBlockRecord<B>[] = [];
    for (const r of prev) {
      const { from, to } = r.block;
      const nf = tr.changes.mapPos(from, 1);
      const nt = tr.changes.mapPos(to, -1);
      if (tr.changes.touchesRange(from, to) !== false || intersects(span, nf, nt)) {
        changed = true;
      } else if (nf === from && nt === to) {
        next.push(r);
      } else {
        changed = true;
        const rebased = makeRecord({ ...r.block, from: nf, to: nt });
        if (rebased !== null) {
          next.push(rebased);
        }
      }
    }
    const reused = next.length;
    const visited = new Set<number>();
    for (const iv of span) {
      walk(tr.state, iv.from, iv.to, fmEnd, visited, next);
    }
    if (!changed && next.length === reused) {
      return prev;
    }
    return sortedDisjoint(next);
  };

  const nextRecords = (
    prev: readonly StructuralBlockRecord<B>[],
    tr: Transaction
  ): readonly StructuralBlockRecord<B>[] => {
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
      return { records, decorations: assemble(records, tr.state) };
    },
    provide: (f) => [
      EditorView.decorations.from(f, (s) => s.decorations),
      quollBlockReplaceZones.from(f, (s) => extractRanges(s.decorations)),
    ],
  });
}
