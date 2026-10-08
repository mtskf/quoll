// Node-agnostic reducer behind the "Show more" collapse of long top-level blocks. A client
// (fenced code today) supplies a `LineCollapseSpec`: which Lezer node to look at, the
// block's geometry, its toggle widget, and its doc-change invalidation policy. This file
// owns everything else: sticky expanded keys, host-reseed reset, the auto-expand of a
// selection head inside a concealed range, record reuse, and the toggle command.
//
// Block widgets MUST come from a StateField — CodeMirror throws on a ViewPlugin
// `block: true` Decoration.replace (see CLAUDE.md block-widget invariant).
//
// Display-only: decorations only, never a document change → byte-identical round-trip.
// The field deliberately does NOT contribute to quollBlockReplaceZones: the concealed
// zone is non-atomic, and reachability is the auto-expand's job.
//
// Why there is no `syntaxTreeAvailable(tr.state, …)` call here: whether a doc change may
// stay on the bounded path is the CLIENT's policy (`docChangePlan`), because each client
// has a different hot path and a different set of non-local edits. The frontier gate (an
// incomplete parse can reveal nodes outside the changed span) therefore lives in the
// client that wants the bounded path.
//
// Outer folds (Decision 6). The expanded "Show less" widget is a `side: 1` point at the
// block's last-line end; a heading fold ends at its section's last node, i.e. the SAME
// offset when the block closes the section, and the fold placeholder is a non-inclusive
// inline replace — so the widget would render after it as an orphan ("# H … Show less").
// Three rules follow, and they only work together:
//   1. `assemble` omits the DECORATION of a record whose anchor a folded range covers, but
//      keeps the record and its sticky `expanded` membership (unfold restores the bar).
//   2. Records, not decorations, are the state of truth: `selectionEntersCollapsed` reads
//      the records, because a suppressed record has no decoration left to find.
//   3. A change of the folded set triggers a FULL rebuild (not a re-assemble). CodeMirror
//      unfolds in the very transaction that moves the selection into a fold (search next,
//      lint jump, outline click); fold gone + head inside a concealed range must give the
//      EXPANDED shape in that same transaction, never a re-emitted collapsed replace over
//      the caret. With no fold extension installed `foldedRanges` is empty: no effect.

import { foldedRanges, syntaxTree } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  type StateEffectType,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { type Interval, intersects } from "../bounded-recompute.js";
import { hostDocumentReseed } from "../host-reseed.js";
import type { QuollWidget } from "../widget-base.js";
import { parkSelectionOutsideConceal } from "./collapse-shared.js";

type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/** What the shared reducer needs to know about one collapsible block. */
export interface CollapseBlock<X> {
  /** Stable block key: the first line's `line.from`. */
  key: number;
  /** First concealed offset (start of line THRESHOLD+1). */
  concealFrom: number;
  /** Anchor of the expanded "Show less" widget (end of the last concealed content line). */
  concealTo: number;
  /** Upper bound of the collapsed replace range AND of the auto-expand interval. */
  collapseTo: number;
  /** Liveness extent end: an edit in [key, blockTo] invalidates the record. */
  blockTo: number;
  /** Number of concealed lines, shown in the label. */
  hiddenCount: number;
  /** A caret position guaranteed outside [concealFrom, collapseTo] (end of the last
   *  visible line) — where heads are parked on collapse. */
  safeCaret: number;
  /** Client payload handed back to `makeWidget` (the record must carry it: a reused
   *  record whose position shifted re-creates its widget with the mapped key). */
  extra: X;
}

/** The record the reducer keeps per block. */
export interface CollapseRecord<X> {
  key: number;
  blockFrom: number;
  blockTo: number;
  expanded: boolean;
  hiddenCount: number;
  decoFrom: number;
  decoTo: number;
  deco: Decoration;
  extra: X;
}

/** The part of a client that find/toggle need — deliberately WITHOUT the widget factory
 *  and the invalidation policy, so a client's `*-state.ts` can define it and its widget
 *  can import the toggle from there without an import cycle (widget → state only). */
export interface CollapseTarget<X> {
  /** Lezer node name; only DIRECT children of `Document` are considered. */
  nodeName: string;
  /** Block data for `node`, or null when it is not collapsible. */
  blockFor(state: EditorState, node: SyntaxNode): CollapseBlock<X> | null;
  effect: StateEffectType<{ key: number; expanded: boolean }>;
}

export interface LineCollapseSpec<X> extends CollapseTarget<X> {
  makeWidget(args: { key: number; expanded: boolean; hiddenCount: number; extra: X }): QuollWidget;
  /** The client's doc-change invalidation policy, called only for a plain docChanged
   *  transaction (no reseed, no toggle effect). Return "full" to rebuild every record,
   *  or the intervals to re-walk (records untouched by the change and outside the
   *  intervals are reused). Under-reporting here is the unsound direction. */
  docChangePlan(tr: Transaction, prevBlocks: readonly CollapseRecord<X>[]): "full" | Interval[];
}

export interface CollapseState<X> {
  /** Keys (first-line offsets) of explicitly- or auto-expanded blocks. */
  expanded: ReadonlySet<number>;
  /** Document-ordered reuse records — one per collapsible block. */
  blocks: CollapseRecord<X>[];
  decorations: DecorationSet;
}

/** DD4: any selection range whose HEAD sits in the closed interval [from, to].
 *  Checks every range (multi-cursor), not just main — a secondary caret in a
 *  concealed region must auto-expand. A select-all's single range has its head at
 *  doc end, so mid-document blocks are NOT expanded. */
function anyHeadInside(selection: EditorSelection, from: number, to: number): boolean {
  for (const r of selection.ranges) {
    if (r.head >= from && r.head <= to) {
      return true;
    }
  }
  return false;
}

/** Build the record for one collapsible block. Collapsed → a block replace over
 *  [concealFrom, collapseTo]; expanded → a side:1 point widget at concealTo. `blockTo`
 *  is the LIVENESS extent, distinct from the decoration range. */
function recordFor<X>(
  spec: LineCollapseSpec<X>,
  g: CollapseBlock<X>,
  isExpanded: boolean
): CollapseRecord<X> {
  const widget = spec.makeWidget({
    key: g.key,
    expanded: isExpanded,
    hiddenCount: g.hiddenCount,
    extra: g.extra,
  });
  if (isExpanded) {
    return {
      key: g.key,
      blockFrom: g.key,
      blockTo: g.blockTo,
      expanded: true,
      hiddenCount: g.hiddenCount,
      decoFrom: g.concealTo,
      decoTo: g.concealTo,
      deco: Decoration.widget({ widget, block: true, side: 1 }),
      extra: g.extra,
    };
  }
  return {
    key: g.key,
    blockFrom: g.key,
    blockTo: g.blockTo,
    expanded: false,
    hiddenCount: g.hiddenCount,
    decoFrom: g.concealFrom,
    decoTo: g.collapseTo,
    deco: Decoration.replace({ widget, block: true }),
    extra: g.extra,
  };
}

/** Walk every TOP-LEVEL collapsible block whose FULL extent overlaps [rangeFrom, rangeTo]
 *  and emit its record. Expanded iff key ∈ `expanded` OR a selection head sits inside its
 *  concealed region (auto-expand, DD4). */
function buildRange<X>(
  spec: LineCollapseSpec<X>,
  state: EditorState,
  expanded: ReadonlySet<number>,
  rangeFrom: number,
  rangeTo: number
): CollapseRecord<X>[] {
  const out: CollapseRecord<X>[] = [];
  syntaxTree(state).iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      if (node.name === spec.nodeName) {
        const g = spec.blockFor(state, node.node);
        if (g !== null) {
          const isExpanded =
            expanded.has(g.key) || anyHeadInside(state.selection, g.concealFrom, g.collapseTo);
          out.push(recordFor(spec, g, isExpanded));
        }
        return false; // never descend into a collapsible body
      }
      // Descend only through the Document root; skip every other subtree.
      return node.name === "Document" ? undefined : false;
    },
  });
  return out;
}

/** Is `pos` inside a folded range, i.e. would a decoration anchored there render beside
 *  the fold placeholder? A range ending exactly at `pos` counts (the section-end case). */
function hiddenByFold(folded: ReturnType<typeof foldedRanges>, pos: number): boolean {
  let hidden = false;
  folded.between(pos, pos, (from, to) => {
    if (from < pos && to >= pos) {
      hidden = true;
      return false;
    }
    return undefined;
  });
  return hidden;
}

/** Assemble the field state from a record list (dedupes + orders by blockFrom). Filters
 *  decorations only — records are passed through by reference, never copied. The folded
 *  set is fetched once, and the filter is skipped when no fold exists (the fenced typing
 *  path pays nothing). */
function assemble<X>(blocks: CollapseRecord<X>[], state: EditorState): CollapseState<X> {
  const sorted = [...blocks].sort((a, b) => a.blockFrom - b.blockFrom);
  const liveExpanded = new Set<number>();
  for (const b of sorted) {
    if (b.expanded) {
      liveExpanded.add(b.key);
    }
  }
  const folded = foldedRanges(state);
  const visible =
    folded.size === 0 ? sorted : sorted.filter((b) => !hiddenByFold(folded, b.decoFrom));
  const decorations = Decoration.set(
    visible.map((b) => b.deco.range(b.decoFrom, b.decoTo)),
    true
  );
  return { expanded: liveExpanded, blocks: sorted, decorations };
}

export function buildCollapseState<X>(
  spec: LineCollapseSpec<X>,
  state: EditorState,
  expanded: ReadonlySet<number>
): CollapseState<X> {
  return assemble(buildRange(spec, state, expanded, 0, state.doc.length), state);
}

/** DD2 fast-path: does any selection head sit inside a CURRENTLY-collapsed region
 *  (a collapsed record's [decoFrom, decoTo], from < to — read from the records, not the
 *  decorations: a fold-suppressed record has none) of `prev`? The only selection-driven
 *  decoration change is auto-EXPAND (expanded blocks are sticky and never
 *  re-collapse on caret-leave), so a selection-only transaction needs a rebuild
 *  ONLY when a head newly enters a collapsed region. */
function selectionEntersCollapsed<X>(
  blocks: readonly CollapseRecord<X>[],
  selection: EditorSelection
): boolean {
  return blocks.some(
    (b) => !b.expanded && b.decoFrom < b.decoTo && anyHeadInside(selection, b.decoFrom, b.decoTo)
  );
}

/** Reconstruct a reused record at shifted positions (bytes unchanged → geometry shifts
 *  rigidly; only the widget key needs remapping so the toggle command still resolves
 *  the block). Returns `b` VERBATIM when nothing shifted — the reference-identity the
 *  non-vacuity test asserts. */
function shiftRecord<X>(
  spec: LineCollapseSpec<X>,
  b: CollapseRecord<X>,
  tr: Transaction
): CollapseRecord<X> {
  const key = tr.changes.mapPos(b.key, 1);
  const blockFrom = tr.changes.mapPos(b.blockFrom, 1);
  const blockTo = tr.changes.mapPos(b.blockTo, -1);
  const decoFrom = tr.changes.mapPos(b.decoFrom, 1);
  const decoTo = b.expanded ? decoFrom : tr.changes.mapPos(b.decoTo, -1);
  if (
    key === b.key &&
    blockFrom === b.blockFrom &&
    blockTo === b.blockTo &&
    decoFrom === b.decoFrom &&
    decoTo === b.decoTo
  ) {
    return b;
  }
  const widget = spec.makeWidget({
    key,
    expanded: b.expanded,
    hiddenCount: b.hiddenCount,
    extra: b.extra,
  });
  const deco = b.expanded
    ? Decoration.widget({ widget, block: true, side: 1 })
    : Decoration.replace({ widget, block: true });
  return {
    key,
    blockFrom,
    blockTo,
    expanded: b.expanded,
    hiddenCount: b.hiddenCount,
    decoFrom,
    decoTo,
    deco,
    extra: b.extra,
  };
}

/** Reuse prev records whose FULL extent [blockFrom, blockTo] is untouched AND outside
 *  the span; re-walk the tree only inside the span. Full-extent liveness — NOT the
 *  decoration range, which covers only the concealed tail. */
function computeBounded<X>(
  spec: LineCollapseSpec<X>,
  prevBlocks: readonly CollapseRecord<X>[],
  tr: Transaction,
  intervals: Interval[],
  working: ReadonlySet<number>
): CollapseState<X> {
  const byFrom = new Map<number, CollapseRecord<X>>();
  for (const b of prevBlocks) {
    const touched = tr.changes.touchesRange(b.blockFrom, b.blockTo) !== false;
    const newFrom = tr.changes.mapPos(b.blockFrom, 1);
    const newTo = tr.changes.mapPos(b.blockTo, -1);
    if (!touched && !intersects(intervals, newFrom, newTo)) {
      const r = shiftRecord(spec, b, tr);
      byFrom.set(r.blockFrom, r);
    }
  }
  for (const iv of intervals) {
    for (const r of buildRange(spec, tr.state, working, iv.from, iv.to)) {
      byFrom.set(r.blockFrom, r); // fresh wins (a block spanning two intervals de-dupes)
    }
  }
  return assemble([...byFrom.values()], tr.state);
}

/** The collapsible block whose key is `key`, or null — recomputed FRESH at click time (no
 *  stale closure). Iterates `Document` children and matches `doc.lineAt(node.from).from`
 *  (an indented block's `node.from` is after its indent, so `resolveInner(key)` misses it). */
export function findCollapseBlockAt<X>(
  target: CollapseTarget<X>,
  state: EditorState,
  key: number
): CollapseBlock<X> | null {
  if (key < 0 || key > state.doc.length) {
    return null;
  }
  let result: CollapseBlock<X> | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (result !== null) {
        return false; // already found — stop walking
      }
      if (node.name === target.nodeName) {
        if (state.doc.lineAt(node.from).from === key) {
          result = target.blockFor(state, node.node);
        }
        return false; // never descend into a collapsible body
      }
      // Top-level blocks are Document children; nothing else can contain one.
      return node.name === "Document" ? undefined : false;
    },
  });
  return result;
}

/** Toggle the block keyed by `key`. Expand → dispatch `target.effect`. Collapse → the effect
 *  plus, in the SAME transaction, parking every selection head inside [concealFrom,
 *  collapseTo] at `safeCaret`, so the build's auto-expand does not immediately re-open it.
 *  A stale key resolves to null → the effect alone (it only edits the Set), so there is no
 *  error path. */
export function toggleCollapse<X>(
  view: EditorView,
  target: CollapseTarget<X>,
  key: number,
  expand: boolean
): void {
  const effects = target.effect.of({ key, expanded: expand });
  if (expand) {
    view.dispatch({ effects });
    return;
  }
  const block = findCollapseBlockAt(target, view.state, key);
  const parked =
    block === null
      ? null
      : parkSelectionOutsideConceal(
          view.state.selection,
          block.concealFrom,
          // Park heads on the trailing edge too (collapseTo, not concealTo): otherwise
          // collapsing with the caret there would auto-expand right back.
          block.collapseTo,
          block.safeCaret
        );
  view.dispatch(parked !== null ? { effects, selection: parked } : { effects });
}

/** One reducer, two configs. `bounded` (production) asks the client's `docChangePlan` on a
 *  plain docChanged; `full` (test-only oracle) always full-recomputes there. Both share
 *  every other branch (reseed / effect / background-parse / selection), so the full
 *  variant threads the SAME sticky `expanded` state — which a fresh EditorState.create
 *  cannot model — making bounded≡full a true replay equivalence. The oracle omits
 *  `provide` so two block-decoration fields never collide in one view. */
export function defineLineCollapseField<X>(
  spec: LineCollapseSpec<X>,
  mode: "bounded" | "full"
): StateField<CollapseState<X>> {
  return StateField.define<CollapseState<X>>({
    create: (state) => buildCollapseState(spec, state, new Set()),
    update: (prev, tr) => {
      // 1. DD3 host-snapshot reseed → rebuild from EMPTY.
      if (tr.annotation(hostDocumentReseed) === true && tr.docChanged) {
        return buildCollapseState(spec, tr.state, new Set());
      }
      // 2. Map expanded keys through the change; apply toggle effects (DD5).
      let working: ReadonlySet<number> = prev.expanded;
      if (tr.docChanged) {
        const mapped = new Set<number>();
        for (const k of prev.expanded) {
          mapped.add(tr.changes.mapPos(k, 1));
        }
        working = mapped;
      }
      let effectTouched = false;
      for (const e of tr.effects) {
        if (e.is(spec.effect)) {
          effectTouched = true;
          const next = new Set(working);
          if (e.value.expanded) {
            next.add(e.value.key);
          } else {
            next.delete(e.value.key);
          }
          working = next;
        }
      }
      // 3. Effect toggle (rare user gesture — a toggled block can be anywhere) → full.
      if (effectTouched) {
        return buildCollapseState(spec, tr.state, working);
      }
      // 4. Doc change: the client decides between a full rebuild and a bounded re-walk.
      //    `mode === "full"` is NOT a structural check: it is the switch that makes the
      //    test-only full-recompute oracle, never true for the field wired into editor.ts.
      if (tr.docChanged) {
        const plan = mode === "full" ? "full" : spec.docChangePlan(tr, prev.blocks);
        if (plan === "full") {
          return buildCollapseState(spec, tr.state, working);
        }
        return computeBounded(spec, prev.blocks, tr, plan, working);
      }
      // 5. Background-parse publication (tree identity changed, no doc change) → full
      //    to self-heal any node the earlier bounded walk could not see.
      if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        return buildCollapseState(spec, tr.state, working);
      }
      // 6. Fold set changed (no doc change) → FULL rebuild so auto-expand is re-evaluated
      //    against the new folds in this same transaction (header, rule 3). `RangeSet.map`
      //    returns `this` for empty changes, so a plain caret move never trips this.
      if (foldedRanges(tr.startState) !== foldedRanges(tr.state)) {
        return buildCollapseState(spec, tr.state, working);
      }
      // 7. Selection-only: rebuild ONLY when a head enters a currently-collapsed region
      //    (auto-expand). Otherwise decorations are unchanged — return `prev` verbatim.
      const selectionMoved = !tr.startState.selection.eq(tr.state.selection);
      if (selectionMoved && selectionEntersCollapsed(prev.blocks, tr.state.selection)) {
        return buildCollapseState(spec, tr.state, working);
      }
      return prev;
    },
    ...(mode === "bounded"
      ? {
          provide: (f: StateField<CollapseState<X>>) =>
            EditorView.decorations.from(f, (s) => s.decorations),
        }
      : {}),
  });
}
