// StateField that collapses long TOP-LEVEL fenced code blocks: bodies with more
// than COLLAPSE_THRESHOLD lines render their first 10 lines plus a "Show more" bar,
// with the rest concealed by a block Decoration.replace. Expansion is sticky (a
// per-block Set of expanded keys, default empty = all collapsed) and is also
// auto-driven when the selection head lands inside a concealed region (mirrors
// CodeMirror's native fold auto-unfold, so the caret can never be trapped).
//
// Block widgets MUST come from a StateField — CodeMirror throws on a ViewPlugin
// `block: true` Decoration.replace (see CLAUDE.md block-widget invariant + memory
// quoll-cm-block-widgets-must-be-statefield).
//
// Display-only: decorations only, never a document change → byte-identical
// round-trip, no `edit` posted (parity with every other fenced-code widget). The
// field deliberately does NOT contribute to quollBlockReplaceZones: the concealed
// zone is non-atomic, and reachability is the auto-expand's job — not the generic
// blockZoneArrowKeymap's.

import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import {
  type EditorSelection,
  type EditorState,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { hostDocumentReseed } from "../frontmatter/reveal-state.js";
import { fencedBlockGeometry, setFencedCollapseEffect } from "./fenced-code-collapse-state.js";
import { FencedCollapseToggleWidget } from "./fenced-code-collapse-widget.js";

interface FencedBlockRecord {
  key: number;
  blockFrom: number;
  blockTo: number;
  expanded: boolean;
  hiddenCount: number;
  decoFrom: number;
  decoTo: number;
  deco: Decoration;
}

interface CollapseState {
  /** Keys (open-fence offsets) of explicitly- or auto-expanded blocks. */
  expanded: ReadonlySet<number>;
  /** Document-ordered reuse records — one per collapsible block. */
  blocks: FencedBlockRecord[];
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
 *  is the LIVENESS extent (closed → collapseTo; unclosed → docLength), distinct from
 *  the decoration range. */
function recordFor(
  g: { key: number; concealFrom: number; concealTo: number; collapseTo: number; closed: boolean },
  isExpanded: boolean,
  hiddenCount: number,
  docLength: number
): FencedBlockRecord {
  const blockTo = g.closed ? g.collapseTo : docLength;
  if (isExpanded) {
    return {
      key: g.key,
      blockFrom: g.key,
      blockTo,
      expanded: true,
      hiddenCount,
      decoFrom: g.concealTo,
      decoTo: g.concealTo,
      deco: Decoration.widget({
        widget: new FencedCollapseToggleWidget(g.key, true, hiddenCount),
        block: true,
        side: 1,
      }),
    };
  }
  return {
    key: g.key,
    blockFrom: g.key,
    blockTo,
    expanded: false,
    hiddenCount,
    decoFrom: g.concealFrom,
    decoTo: g.collapseTo,
    deco: Decoration.replace({
      widget: new FencedCollapseToggleWidget(g.key, false, hiddenCount),
      block: true,
    }),
  };
}

/** Walk every TOP-LEVEL collapsible FencedCode whose FULL extent overlaps
 *  [rangeFrom, rangeTo] and emit its record. Expanded iff key ∈ `expanded` OR a
 *  selection head sits inside its concealed region (auto-expand, DD4). */
function buildFencedRange(
  state: EditorState,
  expanded: ReadonlySet<number>,
  rangeFrom: number,
  rangeTo: number
): FencedBlockRecord[] {
  const out: FencedBlockRecord[] = [];
  const docLength = state.doc.length;
  syntaxTree(state).iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      if (node.name === "FencedCode") {
        const g = fencedBlockGeometry(state, node.node);
        if (g !== null) {
          const isExpanded =
            expanded.has(g.key) || anyHeadInside(state.selection, g.concealFrom, g.collapseTo);
          const hiddenCount =
            state.doc.lineAt(g.concealTo).number - state.doc.lineAt(g.concealFrom).number + 1;
          out.push(recordFor(g, isExpanded, hiddenCount, docLength));
        }
        return false; // never descend into a code body
      }
      // Descend only through the Document root; skip every other subtree.
      return node.name === "Document" ? undefined : false;
    },
  });
  return out;
}

/** Assemble the field state from a record list (dedupes + orders by blockFrom). */
function assemble(blocks: FencedBlockRecord[]): CollapseState {
  const sorted = [...blocks].sort((a, b) => a.blockFrom - b.blockFrom);
  const liveExpanded = new Set<number>();
  for (const b of sorted) {
    if (b.expanded) {
      liveExpanded.add(b.key);
    }
  }
  const decorations = Decoration.set(
    sorted.map((b) => b.deco.range(b.decoFrom, b.decoTo)),
    true
  );
  return { expanded: liveExpanded, blocks: sorted, decorations };
}

function buildFullState(state: EditorState, expanded: ReadonlySet<number>): CollapseState {
  return assemble(buildFencedRange(state, expanded, 0, state.doc.length));
}

/** Public helper kept for the existing unit tests — a thin projection of the full
 *  state (decorations + a fresh copy of the reconciled live expanded-key set). */
export function buildFencedCollapse(
  state: EditorState,
  expanded: ReadonlySet<number>
): { decorations: DecorationSet; liveExpanded: Set<number> } {
  const s = buildFullState(state, expanded);
  return { decorations: s.decorations, liveExpanded: new Set(s.expanded) };
}

/** DD2 fast-path: does any selection head sit inside a CURRENTLY-collapsed region
 *  (a block-replace range, from < to) of `prev`? The only selection-driven
 *  decoration change is auto-EXPAND (expanded blocks are sticky and never
 *  re-collapse on caret-leave), so a selection-only transaction needs a rebuild
 *  ONLY when a head newly enters a collapsed region. */
function selectionEntersCollapsed(prev: DecorationSet, selection: EditorSelection): boolean {
  const iter = prev.iter();
  while (iter.value !== null) {
    if (iter.from < iter.to && anyHeadInside(selection, iter.from, iter.to)) {
      return true;
    }
    iter.next();
  }
  return false;
}

interface Interval {
  from: number;
  to: number;
}

/** GF — fence pairing AND top-level eligibility are non-local:
 *  1. a line becoming/ceasing to be a fence delimiter (```/~~~, ≤3 leading spaces/tabs)
 *     re-pairs fences arbitrarily far away;
 *  2. a line gaining/losing a LIST or BLOCKQUOTE marker changes whether a fence is
 *     container-nested (skipped) or top-level (collapsible) — WITHOUT touching the
 *     fence's own bytes (Codex finding 1).
 *  3. a line that opens or closes an HTML block (e.g. `<script>`, `<!--`, `</script>`,
 *     `-->`) can swallow a following top-level fence WITHOUT touching the fence's bytes:
 *     an unclosed <script>/<!--/<?/<![CDATA[ block, or a type-6/7 tag block, absorbs the
 *     fence into the HTMLBlock node, making it invisible to the top-level tree walk.
 *  STRUCTURAL is a purely SYNTACTIC over-approximation on changed-line text: it
 *  deliberately over-triggers on any fence-shaped, container-marker-shaped, or
 *  HTML-tag-shaped changed line (safe — a false full-recompute only costs speed;
 *  under-triggering is unsound). The hot path stays bounded only for edits whose
 *  changed lines carry none of those shapes (plain code body or plain prose — which the
 *  fenced-heavy perf case is).
 *  WHY blank-line edits need NOT be caught (verified, do NOT re-add a blank-line rule):
 *  a fence's top-level eligibility is pinned by its OWN opener-line indentation plus the
 *  container-marker lines above it — NOT by blank-line grouping. A parser probe confirmed
 *  that no blank-line-only edit flips containment: an INDENTED fence stays nested and a
 *  COLUMN-0 fence stays top-level across blank insert/delete (deleting the blank between a
 *  list and a following column-0 fence keeps it top-level — column-0 cannot lazy-continue
 *  a list item; adding a second blank before a nested fence keeps it nested). Flipping
 *  requires editing the MARKER line or the fence's own INDENTATION — both land on a
 *  STRUCTURAL-matching line (marker alt, or the fence delimiter alt which allows ≤3
 *  leading spaces). This is the crucial difference from imageBlockField: a *paragraph* IS
 *  regrouped by adjacent blank lines (hence image G1's ±1), but a *fence* is not. G2 +
 *  the background-parse self-heal remain as defense-in-depth for anything exotic. */
const STRUCTURAL =
  /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})|(?:^|\n)[ \t]*(?:[-*+]|\d{1,9}[.)]|>)|(?:^|\n)[ \t]{0,3}<[/!?A-Za-z]|-->|\?>|\]\]>/;
function touchesStructural(tr: Transaction): boolean {
  let hit = false;
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    if (hit) {
      return;
    }
    const oldSlice = tr.startState.doc.sliceString(
      tr.startState.doc.lineAt(fromA).from,
      tr.startState.doc.lineAt(toA).to
    );
    const newSlice = tr.state.doc.sliceString(
      tr.state.doc.lineAt(fromB).from,
      tr.state.doc.lineAt(toB).to
    );
    if (STRUCTURAL.test(oldSlice) || STRUCTURAL.test(newSlice)) {
      hit = true;
    }
  });
  return hit;
}

function lineExpand(state: EditorState, from: number, to: number): Interval {
  const len = state.doc.length;
  const lo = state.doc.lineAt(Math.max(0, Math.min(from, len)));
  const hi = state.doc.lineAt(Math.max(0, Math.min(to, len)));
  // ±1 line neighbour (belt-and-suspenders parity with imageBlockField G1).
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

/** Changed range(s) ∪ old/new selection ranges, each line-expanded (±1). Selection
 *  ranges are included so a block whose auto-expand status flips (a head entering/
 *  leaving its concealed region) is inside the span and rebuilt. */
function computeExtendedSpan(tr: Transaction): Interval[] {
  const state = tr.state;
  const raw: Interval[] = [];
  if (tr.docChanged) {
    tr.changes.iterChangedRanges((_fa, _ta, fromB, toB) => raw.push(lineExpand(state, fromB, toB)));
  }
  for (const r of tr.startState.selection.ranges) {
    const a = tr.changes.mapPos(r.from, 1);
    const b = tr.changes.mapPos(r.to, -1);
    raw.push(lineExpand(state, Math.min(a, b), Math.max(a, b)));
  }
  for (const r of tr.state.selection.ranges) {
    raw.push(lineExpand(state, r.from, r.to));
  }
  return mergeIntervals(raw);
}

function intersectsAny(intervals: Interval[], from: number, to: number): boolean {
  for (const iv of intervals) {
    if (from <= iv.to && iv.from <= to) {
      return true;
    }
  }
  return false;
}

/** Reconstruct a reused record at shifted positions (bytes unchanged → geometry shifts
 *  rigidly; only the widget key needs remapping so the toggle command still resolves
 *  the block). Returns `b` VERBATIM when nothing shifted — the reference-identity the
 *  non-vacuity test asserts. */
function shiftRecord(b: FencedBlockRecord, tr: Transaction): FencedBlockRecord {
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
  const widget = new FencedCollapseToggleWidget(key, b.expanded, b.hiddenCount);
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
  };
}

/** Reuse prev records whose FULL extent [blockFrom, blockTo] is untouched AND outside
 *  the span; re-walk the tree only inside the span. Full-extent liveness — NOT the
 *  decoration range, which covers only the concealed tail. */
function computeBounded(
  prevBlocks: readonly FencedBlockRecord[],
  tr: Transaction,
  intervals: Interval[],
  working: ReadonlySet<number>
): CollapseState {
  const byFrom = new Map<number, FencedBlockRecord>();
  for (const b of prevBlocks) {
    const touched = tr.changes.touchesRange(b.blockFrom, b.blockTo) !== false;
    const newFrom = tr.changes.mapPos(b.blockFrom, 1);
    const newTo = tr.changes.mapPos(b.blockTo, -1);
    if (!touched && !intersectsAny(intervals, newFrom, newTo)) {
      const r = shiftRecord(b, tr);
      byFrom.set(r.blockFrom, r);
    }
  }
  for (const iv of intervals) {
    for (const r of buildFencedRange(tr.state, working, iv.from, iv.to)) {
      byFrom.set(r.blockFrom, r); // fresh wins (a block spanning two intervals de-dupes)
    }
  }
  return assemble([...byFrom.values()]);
}

type BuildMode = "bounded" | "full";

/** One reducer, two configs. `bounded` (production) takes the changed-range path on a
 *  plain docChanged; `full` (test-only oracle) always full-recomputes there. Both share
 *  every other branch (reseed / effect / GF / background-parse / selection), so the full
 *  variant threads the SAME sticky `expanded` state — which a fresh EditorState.create
 *  cannot model — making bounded≡full a true replay equivalence. The oracle omits
 *  `provide` so two block-decoration fields never collide in one view. */
function defineField(mode: BuildMode): StateField<CollapseState> {
  return StateField.define<CollapseState>({
    create: (state) => buildFullState(state, new Set()),
    update: (prev, tr) => {
      // 1. DD3 host-snapshot reseed → rebuild from EMPTY.
      if (tr.annotation(hostDocumentReseed) === true && tr.docChanged) {
        return buildFullState(tr.state, new Set());
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
        if (e.is(setFencedCollapseEffect)) {
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
      //    GF structural edit (fence-delimiter / container-marker) → full (non-local).
      if (effectTouched || (tr.docChanged && touchesStructural(tr))) {
        return buildFullState(tr.state, working);
      }
      // 4. Hot path: a plain docChanged rebuilds changed-range-bounded, with the G2
      //    frontier fallback (an incomplete parse can reveal nodes outside the span).
      if (tr.docChanged) {
        if (mode === "full" || !syntaxTreeAvailable(tr.state, tr.state.doc.length)) {
          return buildFullState(tr.state, working);
        }
        return computeBounded(prev.blocks, tr, computeExtendedSpan(tr), working);
      }
      // 5. Background-parse publication (tree identity changed, no doc change) → full
      //    to self-heal any node the earlier bounded walk could not see.
      if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
        return buildFullState(tr.state, working);
      }
      // 6. Selection-only: rebuild ONLY when a head enters a currently-collapsed region
      //    (auto-expand). Otherwise decorations are unchanged — return `prev` verbatim.
      const selectionMoved = !tr.startState.selection.eq(tr.state.selection);
      if (selectionMoved && selectionEntersCollapsed(prev.decorations, tr.state.selection)) {
        return buildFullState(tr.state, working);
      }
      return prev;
    },
    ...(mode === "bounded"
      ? {
          provide: (f: StateField<CollapseState>) =>
            EditorView.decorations.from(f, (s) => s.decorations),
        }
      : {}),
  });
}

export const fencedCodeCollapseField = defineField("bounded");
// Test-only oracle — identical reducer, always full-recompute on docChanged, NO
// `provide` (never wired into editor.ts). Used by cm-fenced-collapse-bounded.test.ts
// as the bounded≡full oracle; it carries the same sticky expanded state.
export const fencedCodeCollapseFieldFullRecompute = defineField("full");
