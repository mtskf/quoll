// StateField that CONCEALS the `[!TYPE]` marker row of a callout when the caret is
// OUTSIDE the whole callout block (mirrors fenced-code-collapse.ts's rebuild-on-
// selection template). Per concealed marker line it emits, over the WHOLE line:
//   - Decoration.line({ class: CALLOUT_MARKER_HIDDEN_CLASS }) — the zero-height
//     collapse (the theme copies `.quoll-fenced-code-fence-hidden`), and
//   - Decoration.replace({}) over [line.from, line.to) — hides the row content,
// and publishes [line.from, line.to] to quollSyntaxExclusionZones so:
//   - the orchestrator's arbitrate() drops EVERY inline reveal decoration on that
//     line (the leading `>`, inline marks, links) → exactly ONE replace covers the
//     row, with no overlapping-replace crash surface (v2 Finding 2); and
//   - block-style.ts skips the concealed marker line (buildBlockLineDecorations
//     point-excludes it) and migrates the rounded `-open` corner
//     onto the first visible body line.
//
// A StateField (NOT an inline reveal provider) because a marker line can carry
// inline markup (`> [!TIP] **title**`): an inline provider hiding only the
// `[!TYPE]` run while blockquote-reveal independently hides the `>` would leave TWO
// overlapping Decoration.replace on the line → CodeMirror throws and blanks the
// whole set. Owning the whole line as ONE replace + publishing the zone is the
// single-replace design (CLAUDE.md callout invariant + the plan's crash regression).
//
// Display-only: never mutates bytes → the `[!TYPE]` source round-trips identically.
// The concealed row is a NON-atomic inline replace, so its byte positions stay
// caret-reachable; entering the block from either side reveals the editable source
// (no quollBlockReplaceZones contribution → no atomic skip; a zero-height line may
// be visually skipped by Arrow keys, which is correct UX — no caret trap exists).

import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { type EditorState, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

import { type Interval, intersects, mergeIntervals } from "../bounded-recompute.js";
import { hostDocumentReseed } from "../frontmatter/reveal-state.js";
import { expandToEnclosingBlock, touchesStructuralReparse } from "../structural-guard.js";
import { CALLOUT_MARKER_HIDDEN_CLASS, calloutTypeForOutermost } from "./callout.js";
import { quollSyntaxExclusionZones } from "./orchestrator.js";
import { intersectsAnySelection } from "./shared.js";

type Zone = { from: number; to: number };

/** Selection-INDEPENDENT facts about one outermost callout that HAS a body (a
 *  marker-only callout is never a record — it never conceals). `markerFrom` is
 *  both the block's first-line start AND the concealed marker span's start;
 *  `blockTo` is the block's last CONTENT line end (`doc.lineAt(node.to - 1).to`,
 *  robust to a Lezer `to` overshoot per [[quoll-lezer-table-to-overshoots-trailing-line]]).
 *  The selection-dependent conceal decision is applied later in `deriveMarkers`. */
interface CalloutRecord {
  markerFrom: number;
  markerTo: number;
  blockTo: number;
}

interface ConcealState {
  /** Selection-independent, doc-ordered by `markerFrom`. The changed-range bounded
   *  recompute (Task 2) reuses/rebuilds THIS; markers/decorations/zones derive from it. */
  records: readonly CalloutRecord[];
  /** Concealed marker-line spans for the CURRENT selection, doc-ordered. Compared on
   *  a selection-only move to keep `prev` verbatim (F3). */
  markers: readonly Zone[];
  decorations: DecorationSet;
  /** Published exclusion zones — same content as `markers`, a distinct field so the
   *  facet provider returns a stable reference whenever `update` keeps `prev` (F3). */
  zones: readonly Zone[];
}

/** Collect every outermost callout WITH a body whose Blockquote node OVERLAPS
 *  [rangeFrom, rangeTo]. Called with [0, doc.length] for a full (re)build and with
 *  each bounded interval on the keystroke path (Task 2). A bounded `{from,to}`
 *  iterate materialises only the touched subtree — the whole point of the bounding
 *  (PERF.md: the cost is whole-tree materialisation, NOT node descent, so this is
 *  the changed-range shape, NOT a prune-descent). Doc order → already sorted by
 *  `markerFrom`. Selection-INDEPENDENT: the caret does not affect record membership.
 *  `calloutTypeForOutermost` already excludes nested (`> >` inner) AND list-nested
 *  (`- > [!NOTE]`) blockquotes (the marker regex anchors at `^ {0,3}>`), so no
 *  container-descent special-casing is needed — a top-level callout is the only shape
 *  that yields a record. A bounded `{from,to}` walk still ENTERS a Blockquote whose
 *  node starts ABOVE `rangeFrom` when it overlaps the range, so an interior edit deep
 *  in a large callout re-emits that callout's record with its true (far-above) marker
 *  line — the property that makes interior-edit reuse-skip sound. */
function buildRange(state: EditorState, rangeFrom: number, rangeTo: number): CalloutRecord[] {
  const doc = state.doc;
  const out: CalloutRecord[] = [];
  syntaxTree(state).iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      if (node.name !== "Blockquote" || calloutTypeForOutermost(doc, node.node) === null) {
        return;
      }
      const firstLine = doc.lineAt(node.from);
      const lastLine = doc.lineAt(node.to - 1);
      if (lastLine.number === firstLine.number) {
        return; // marker-only callout: never a record (never conceals)
      }
      out.push({ markerFrom: firstLine.from, markerTo: firstLine.to, blockTo: lastLine.to });
    },
  });
  return out;
}

function buildFull(state: EditorState): CalloutRecord[] {
  return buildRange(state, 0, state.doc.length);
}

/** The changed regions, each expanded to its enclosing blank-line-delimited block
 *  (G1 — a ±1 window is unsound for blockquote lazy continuation), merged disjoint.
 *  Records are selection-INDEPENDENT, so — unlike imageBlockField — the span does NOT
 *  include selection ranges; a caret move never changes record membership. */
function computeExtendedSpan(tr: Transaction): Interval[] {
  const state = tr.state;
  const raw: Interval[] = [];
  tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    raw.push(expandToEnclosingBlock(state, fromB, toB));
  });
  return mergeIntervals(raw);
}

/** Changed-range bounded record recompute: reuse every prior record whose FULL block
 *  extent [markerFrom, blockTo] is neither TOUCHED by the change nor intersecting the
 *  extendedSpan (position-mapped through `tr.changes`), and re-walk the tree only
 *  INSIDE each span interval. Soundness: a callout's record can change only from
 *  within its block (interior change → touched → re-walked, and the overlapping
 *  Blockquote node — even one starting far above the span — is re-entered by the
 *  bounded `iterate` and re-emitted with its true marker line) or from an adjacent
 *  line (G1 ±1 → intersects span → re-walked). De-dup by `markerFrom` (unique per
 *  callout): a fresh walk over a span always wins over a reused mapping. */
function computeBoundedRecords(
  prev: readonly CalloutRecord[],
  tr: Transaction,
  intervals: Interval[]
): CalloutRecord[] {
  const byMarker = new Map<number, CalloutRecord>();
  for (const rec of prev) {
    const touched = tr.changes.touchesRange(rec.markerFrom, rec.blockTo) !== false;
    const newFrom = tr.changes.mapPos(rec.markerFrom, 1);
    const newTo = tr.changes.mapPos(rec.blockTo, -1);
    if (!touched && !intersects(intervals, newFrom, newTo)) {
      const markerTo = tr.changes.mapPos(rec.markerTo, -1);
      if (newFrom === rec.markerFrom && markerTo === rec.markerTo && newTo === rec.blockTo) {
        // Zero-shift reuse: return the SAME object (block structure unchanged AND
        // positions unmoved — an edit strictly BELOW the record). Object identity is
        // the non-vacuity anchor the reuse test asserts (mirrors imageBlockField
        // reusing the exact deco on a no-shift).
        byMarker.set(rec.markerFrom, rec);
      } else {
        // Position shift only: block structure unchanged (untouched + outside span).
        byMarker.set(newFrom, { markerFrom: newFrom, markerTo, blockTo: newTo });
      }
    }
  }
  for (const iv of intervals) {
    for (const rec of buildRange(tr.state, iv.from, iv.to)) {
      byMarker.set(rec.markerFrom, rec); // fresh wins (a callout spanning two intervals de-dupes)
    }
  }
  return [...byMarker.values()].sort((a, b) => a.markerFrom - b.markerFrom);
}

/** Apply the SELECTION-dependent conceal decision to a record list. A callout's
 *  marker row conceals iff no selection range intersects its full block span
 *  [markerFrom, blockTo] — identical to `calloutBlockRevealed` / `calloutMarkerConceal`
 *  in callout.ts (the marker-only + not-a-callout cases are already excluded at
 *  record-build time). Records are doc-ordered, so markers come out doc-ordered. */
function deriveMarkers(records: readonly CalloutRecord[], state: EditorState): Zone[] {
  const markers: Zone[] = [];
  for (const rec of records) {
    if (!intersectsAnySelection(state.selection, rec.markerFrom, rec.blockTo)) {
      markers.push({ from: rec.markerFrom, to: rec.markerTo });
    }
  }
  return markers;
}

/** The per-marker line-deco + replace share the SAME line.from; a RangeSetBuilder
 *  REJECTS a replace added before a line decoration at the same pos (line decos have
 *  a lower startSide). `Decoration.set(_, true)` sorts them so CM accepts the pair. */
function buildDecorations(markers: readonly Zone[]): DecorationSet {
  const ranges = markers.flatMap((m) => [
    Decoration.line({ class: CALLOUT_MARKER_HIDDEN_CLASS }).range(m.from),
    Decoration.replace({}).range(m.from, m.to),
  ]);
  return Decoration.set(ranges, true);
}

function assemble(records: readonly CalloutRecord[], markers: readonly Zone[]): ConcealState {
  return {
    records,
    markers,
    decorations: buildDecorations(markers),
    zones: markers.map((m) => ({ from: m.from, to: m.to })),
  };
}

function deriveState(records: readonly CalloutRecord[], state: EditorState): ConcealState {
  return assemble(records, deriveMarkers(records, state));
}

/** Content-equality of two marker-span lists (same length, same from/to pairwise).
 *  Both are always doc-ordered, so a positional compare is exact. */
function markersEqual(a: readonly Zone[], b: readonly Zone[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i].from !== b[i].from || a[i].to !== b[i].to) {
      return false;
    }
  }
  return true;
}

export const calloutMarkerConcealField = StateField.define<ConcealState>({
  create: (state) => deriveState(buildFull(state), state),
  update: (prev, tr) => {
    // A host-snapshot reseed (full 0..len replace) rebuilds from the reseeded state —
    // mapping records through a whole-document replace is meaningless (parity with
    // the sibling block fields' reseed branch).
    if (tr.annotation(hostDocumentReseed) === true && tr.docChanged) {
      return deriveState(buildFull(tr.state), tr.state);
    }
    // Doc change: recompute records changed-range-bounded, NOT a whole-tree walk.
    if (tr.docChanged) {
      // A STRUCTURAL reparse (touchesStructuralReparse — an unclosed fence / HTML block
      // swallowing the callout below it, a `<!DOCTYPE …>` terminator, an un-list /
      // heading-interrupt re-context, etc.) re-shapes block boundaries OUTSIDE the
      // changed run, so a callout's Blockquote-ness can flip WITHOUT any edit inside its
      // block — the changed-range bounded window would strand the stale record. G2: if
      // the post-edit parser frontier is incomplete, a docChanged transaction can also
      // reveal Blockquote nodes OUTSIDE the changed range, so the bounded reuse is
      // unsound. Either → walk the CURRENTLY-AVAILABLE tree over the whole doc instead
      // (NOT a guaranteed-complete parse — the same self-heal contract the sibling block
      // + fold-gutter fields use: a later background-parse publication arrives as a
      // !docChanged tree-identity change and re-walks to converge). buildFull over an
      // incomplete frontier is still a superset-safe fallback: it never bounds away a
      // node the bounded path would have missed.
      if (touchesStructuralReparse(tr) || !syntaxTreeAvailable(tr.state, tr.state.doc.length)) {
        return deriveState(buildFull(tr.state), tr.state);
      }
      const records = computeBoundedRecords(prev.records, tr, computeExtendedSpan(tr));
      return deriveState(records, tr.state);
    }
    // Async background-parse publication (tree identity changed, no doc change):
    // real Blockquote nodes may have just landed → full rebuild to self-heal.
    if (syntaxTree(tr.startState) !== syntaxTree(tr.state)) {
      return deriveState(buildFull(tr.state), tr.state);
    }
    // Selection-only move. Records are selection-INDEPENDENT and the doc did not
    // change, so REUSE prev.records; only the concealed set can differ. Return `prev`
    // VERBATIM when the concealed markers are content-equal — CM re-runs the facet
    // combiner only on a NEW field identity, so a fresh equal-content value would
    // churn quollSyntaxExclusionZones and make block-style rebuild noisily (F3).
    if (!tr.startState.selection.eq(tr.state.selection)) {
      const nextMarkers = deriveMarkers(prev.records, tr.state);
      return markersEqual(nextMarkers, prev.markers) ? prev : assemble(prev.records, nextMarkers);
    }
    return prev;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (s) => s.decorations),
    quollSyntaxExclusionZones.from(f, (s) => s.zones),
  ],
});
