// StateField that renders a file-leading YAML frontmatter fence and drives its
// C8b reveal lifecycle. Holds a RevealState (reveal-state.ts); every view
// artefact below derives from it:
//   - decorations: a `block: true` read-only widget over [0, span.to] ONLY when
//     collapsed; revealed shows the raw source (no decoration).
//   - atomicRanges: the same span ONLY when collapsed (caret skips the opaque
//     block); revealed source is freely navigable.
//   - transactionFilter: read-only (veto any change touching the CLOSED interval
//     [0, span.to]) ONLY when collapsed. A `changeFilter` range-array is NOT
//     enough — its boundaries are OPEN, so a zero-width insertion at 0 or at
//     span.to is admitted, and atomicRanges' caret-skip only fires on the strict
//     interior, letting a keystroke corrupt the `---` opener/closer. Host
//     reseeds (hostDocumentReseed annotation) always pass, in every state. NOTE:
//     keyed on hostDocumentReseed, NOT addToHistory — `addToHistory=false` is a
//     generic history flag, not a host-reseed marker.
//   - quollSyntaxExclusionZones: the span range whenever a span exists, so
//     inline marks + list-hang-indent drop inside the frontmatter whether shown
//     OR revealed (de-markdown in all states).
//
// Does NOT contribute to quollBlockReplaceZones (that drives shown-widget arrow
// navigation, meaningless here; reveal navigation is the custom ArrowUp keymap +
// click handler). Block widgets MUST come from a StateField (CM forbids a
// ViewPlugin `block: true` replace).

import { EditorState, StateField, type Transaction } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";

import { quollSyntaxExclusionZones } from "../decorations/orchestrator.js";
import { FrontmatterBlockWidget } from "./frontmatter-widget.js";
import {
  hostDocumentReseed,
  initialRevealState,
  nextRevealState,
  type RevealState,
} from "./reveal-state.js";

/** The collapsed block-replace + atomic range set (empty in every other
 *  state). Shared by the decorations and atomicRanges providers. */
function collapsedSet(rs: RevealState): DecorationSet {
  if (rs.kind !== "collapsed") {
    return Decoration.none;
  }
  return Decoration.set([
    Decoration.replace({
      widget: new FrontmatterBlockWidget(rs.span.body, rs.span.slice),
      block: true,
    }).range(rs.span.from, rs.span.to),
  ]);
}

/** Read-only guard. Host reseeds (hostDocumentReseed) rewrite the whole doc and
 *  must pass untouched in every state. Otherwise: when collapsed, VETO the whole
 *  transaction (return `[]`) if any of its changes touch the CLOSED interval
 *  [0, span.to] — a body change has fromA > span.to so it passes, while a
 *  boundary insertion at 0 or at span.to (which a `changeFilter` range-array
 *  would admit through its OPEN boundaries) is dropped. The reveal dispatch
 *  (effect + selection, no doc change) has empty changes → passes. When
 *  revealed/absent, allow. */
function transactionFilterFor(rs: RevealState): (tr: Transaction) => Transaction | readonly [] {
  return (tr) => {
    if (tr.annotation(hostDocumentReseed) === true) {
      return tr;
    }
    if (rs.kind !== "collapsed") {
      return tr;
    }
    let unsafe = false;
    tr.changes.iterChanges((fromA) => {
      if (fromA <= rs.span.to) {
        unsafe = true;
      }
    });
    return unsafe ? [] : tr;
  };
}

/** De-markdown zone — the span range whenever a span exists (any reveal state). */
function exclusionRanges(rs: RevealState): readonly { from: number; to: number }[] {
  if (rs.kind === "collapsed" || rs.kind === "revealed") {
    return [{ from: rs.span.from, to: rs.span.to }];
  }
  return [];
}

export const frontmatterBlockField = StateField.define<RevealState>({
  create: (state: EditorState) => initialRevealState(state),
  update: (prev, tr) => nextRevealState(prev, tr),
  provide: (f) => [
    EditorView.decorations.from(f, collapsedSet),
    EditorView.atomicRanges.from(f, (rs) => () => collapsedSet(rs)),
    EditorState.transactionFilter.from(f, transactionFilterFor),
    quollSyntaxExclusionZones.from(f, exclusionRanges),
  ],
});
