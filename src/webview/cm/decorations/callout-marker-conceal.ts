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

import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

import { hostDocumentReseed } from "../frontmatter/reveal-state.js";
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
    // Doc change: rebuild records (Task 2 bounds this; for now, full).
    if (tr.docChanged) {
      return deriveState(buildFull(tr.state), tr.state);
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
