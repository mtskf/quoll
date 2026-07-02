// StateField that renders every GFM Table node as a non-editable block
// widget and publishes the widget's range to the quollBlockReplaceZones
// facet so C4a's inline-reveal orchestrator drops marks inside the widget.
//
// Block widgets MUST be sourced from a StateField, not a ViewPlugin —
// CodeMirror throws if a ViewPlugin emits a `block: true` Decoration.replace
// (the constraint that motivated C4a Task 2 carving out this facet).
//
// Recompute strategy:
//   1. tr.docChanged OR tree-identity changed → walk the tree, parse each
//      table, build a fresh DecorationSet keyed on per-node source slices.
//   2. tr.selection only (no doc/tree change):
//        - if every selection range still resolves to the same line span
//          as before, the per-table line-overlap verdict is unchanged →
//          return `prev` byte-for-byte (no tree walk, no parse).
//        - otherwise, recompute from scratch (one tree walk; the doc is
//          unchanged so per-node sliceDoc remains O(table-bytes)).
//      Cursor moves within the same line — the dominant case — take the
//      identity-return branch. (Codex Conf 91 + error-handler Conf 95.)
//   3. Anything else → return the previous DecorationSet unchanged.
//
// Reveal contract is LINE-LEVEL (Codex Conf 89): if any selection range
// overlaps the LINE RANGE the table occupies (closed-interval overlap so
// caret AT line.from / line.to also reveals), the widget is dropped. This
// mirrors C5's checkbox pattern and matches CM6's default click-on-block
// caret placement (the caret lands at the widget boundary, which is on a
// table line → reveal fires → source becomes editable). Half-open overlap
// would leave a click-at-boundary in the "widget visible" state and the
// user would click without getting source.
//
// Per-table sourcing: each table is parsed from `state.sliceDoc(node.from,
// node.to)` — NOT `state.doc.toString()`. The doc-wide toString materialises
// the whole rope into a single string and is O(doc-bytes) per recompute;
// per-node sliceString is O(table-bytes). Cell `from`/`to` in the parsed
// model are slice-relative (base 0 per node); the widget converts each to an
// absolute document offset (`nodeFrom + from`) stamped as `data-cell-from`,
// which drives click-to-reveal caret placement.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

import { quollBlockReplaceZones } from "../decorations/orchestrator.js";
import { leadingFrontmatterEnd } from "../frontmatter/detect.js";
import { type TableModel, tableModels, tableSkeletonField } from "./table-skeleton.js";
import { TableBlockWidget } from "./table-widget.js";

interface BuiltWidget {
  from: number;
  to: number;
  deco: Decoration;
}

function buildAll(state: EditorState): BuiltWidget[] {
  // Read the bounded-maintained models (no per-keystroke full walk OR per-table
  // re-parse — PERF.md). Fallback to the unbounded full walk+parse when the field
  // is absent (tests / any state that doesn't register it); `??` fires only on
  // `undefined` (field absent), never on an empty `[]` set, so a tableless doc is
  // NOT mistaken for absence.
  const models: readonly TableModel[] =
    state.field(tableSkeletonField, false) ?? tableModels(state);
  const out: BuiltWidget[] = [];
  // The frontmatter block (frontmatterBlockField) owns the outermost block over
  // [0, fmEnd]; never emit a competing block replace inside it.
  const fmEnd = leadingFrontmatterEnd(state);
  models.forEach((m) => {
    if (m.from < fmEnd) {
      return;
    }
    if (m.table === null) {
      return; // non-emitting Table node
    }
    const from = m.blockFrom;
    const to = m.blockTo;
    // Precondition: `Decoration.replace({block: true})` requires from < to. The
    // only reachable rejection is a degenerate zero-width range (Table at doc edge).
    if (from >= to) {
      return;
    }
    out.push({
      from,
      to,
      deco: Decoration.replace({
        // `from` (block line-start) is docFrom; `m.from` (Lezer node start) is
        // nodeFrom — the base for per-cell offsets. `m.slice` is the LF-
        // normalised parse slice (eq key). All three are LF-internal.
        widget: new TableBlockWidget(m.table, m.slice, from, m.from),
        block: true,
      }),
    });
  });
  out.sort((a, b) => a.from - b.from);
  return out;
}

function lineRangeOverlapsSelection(selection: EditorSelection, from: number, to: number): boolean {
  // Line-level closed-interval overlap (Codex Conf 89). `from`/`to` are
  // line-aligned by `buildAll`, so [from, to] inclusive catches caret-at-
  // boundary cases that half-open semantics would miss.
  for (const r of selection.ranges) {
    if (r.from <= to && from <= r.to) {
      return true;
    }
  }
  return false;
}

function computeFresh(state: EditorState): DecorationSet {
  const visible = buildAll(state).filter(
    (b) => !lineRangeOverlapsSelection(state.selection, b.from, b.to)
  );
  if (visible.length === 0) {
    return Decoration.none;
  }
  return Decoration.set(visible.map((b) => b.deco.range(b.from, b.to)));
}

function selectionLineSpansEqual(prevState: EditorState, newState: EditorState): boolean {
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

function updateForTransaction(prev: DecorationSet, tr: Transaction): DecorationSet {
  if (tr.docChanged || syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
    return computeFresh(tr.state);
  }
  if (tr.selection) {
    // Selection-only fast path: if every selection range still sits on
    // the same line-span as before, the per-table overlap verdict is
    // unchanged and we can reuse `prev` byte-for-byte. Cursor moves
    // within the same line — the overwhelmingly common case — short-
    // circuit here and skip both the tree walk and the per-table parse
    // (Codex Conf 91).
    if (selectionLineSpansEqual(tr.startState, tr.state)) {
      return prev;
    }
    return computeFresh(tr.state);
  }
  return prev;
}

function extractRanges(set: DecorationSet): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push({ from: iter.from, to: iter.to });
    iter.next();
  }
  return out;
}

export const tableBlockField = StateField.define<DecorationSet>({
  create: (state) => computeFresh(state),
  update: (value, tr) => updateForTransaction(value, tr),
  provide: (f) => [
    // Widget DecorationSet → editor renders them.
    EditorView.decorations.from(f),
    // Same ranges → C4a's facet so the inline orchestrator drops marks
    // inside the widget.
    quollBlockReplaceZones.from(f, (set) => extractRanges(set)),
  ],
});
