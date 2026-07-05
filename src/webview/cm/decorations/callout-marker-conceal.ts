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
import {
  CALLOUT_MARKER_HIDDEN_CLASS,
  calloutMarkerConceal,
  calloutTypeForOutermost,
} from "./callout.js";
import { quollSyntaxExclusionZones } from "./orchestrator.js";

type Zone = { from: number; to: number };

interface ConcealState {
  /** Concealed marker-line spans (one per outermost callout with a hidden marker),
   *  in document order. Compared on a selection-only move to decide whether to keep
   *  `prev` verbatim (F3). */
  markers: readonly Zone[];
  decorations: DecorationSet;
  /** The published exclusion zones — identical content to `markers`, held as a
   *  distinct field so the facet provider (`s => s.zones`) returns a stable
   *  reference whenever `update` keeps `prev` verbatim (F3). */
  zones: readonly Zone[];
  /** Selection-INDEPENDENT: does ANY outermost callout have ≥1 body line (i.e. a
   *  concealable marker)? Gates the selection-only rebuild (mirrors block-style's
   *  hasBoundaryFence caret-hot-path gate) — a doc with no concealable callout stays
   *  off the caret-move rebuild path. */
  hasConcealable: boolean;
}

/** Walk every Blockquote and collect the marker spans to conceal for the current
 *  selection. `hasConcealable` is computed selection-INDEPENDENTLY (an outermost
 *  callout with a body is concealable regardless of where the caret is now). */
function build(state: EditorState): ConcealState {
  const doc = state.doc;
  const markers: Zone[] = [];
  let hasConcealable = false;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "Blockquote" || calloutTypeForOutermost(doc, node.node) === null) {
        return;
      }
      // Outermost callout. It is CONCEALABLE (independent of the caret) iff it has
      // a body line — a marker-only callout never conceals (see calloutMarkerConceal).
      if (doc.lineAt(node.to - 1).number > doc.lineAt(node.from).number) {
        hasConcealable = true;
      }
      const span = calloutMarkerConceal(doc, state.selection, node.node);
      if (span !== null) {
        markers.push(span);
      }
    },
  });
  // F2 (load-bearing): the per-marker line-deco and replace share the SAME
  // line.from; a RangeSetBuilder REJECTS a replace added before a line decoration
  // at the same pos (line decos have a lower startSide). Decoration.set(_, true)
  // sorts them so CM accepts the pair.
  const ranges = markers.flatMap((m) => [
    Decoration.line({ class: CALLOUT_MARKER_HIDDEN_CLASS }).range(m.from),
    Decoration.replace({}).range(m.from, m.to),
  ]);
  const decorations = Decoration.set(ranges, true);
  const zones: Zone[] = markers.map((m) => ({ from: m.from, to: m.to }));
  return { markers, decorations, zones, hasConcealable };
}

/** Content-equality of two marker-span lists (same length, same from/to pairwise).
 *  Marker lists are always doc-ordered, so a positional compare is exact. */
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
  create: (state) => build(state),
  update: (prev, tr) => {
    // A host-snapshot reseed (full 0..len replace) rebuilds from the reseeded
    // state — mapping marker spans through a whole-document replace is meaningless
    // (parity with fencedCodeCollapseField's reseed branch).
    if (tr.annotation(hostDocumentReseed) === true && tr.docChanged) {
      return build(tr.state);
    }
    const treeChanged = syntaxTree(tr.startState) !== syntaxTree(tr.state);
    // Doc / async-parse changes always rebuild (positions + tree moved).
    if (tr.docChanged || treeChanged) {
      return build(tr.state);
    }
    // Selection-only move. Rebuild ONLY when a callout is concealable (cached,
    // selection-independent gate). Then return `prev` VERBATIM when the rebuilt
    // markers are content-equal — CM only re-runs the facet combiner when this
    // field returns a NEW object identity, so a fresh equal-content value would
    // churn quollSyntaxExclusionZones and make block-style rebuild noisily. This is
    // the exact condition under which "no gate on block-style" (R2) holds (F3).
    const selectionMoved = !tr.startState.selection.eq(tr.state.selection);
    if (selectionMoved && prev.hasConcealable) {
      const next = build(tr.state);
      return markersEqual(next.markers, prev.markers) ? prev : next;
    }
    return prev;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (s) => s.decorations),
    quollSyntaxExclusionZones.from(f, (s) => s.zones),
  ],
});
