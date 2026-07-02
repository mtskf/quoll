// Blockquote syntax-token reveal. Walks QuoteMark nodes DIRECTLY (NOT via
// the outer Blockquote node) so the iterate stays inside ctx.visibleRanges
// even when the outer Blockquote spans many lines (review fix #3).
//
// For each QuoteMark:
//   - Reveal-trigger = the LINE containing the mark
//     (state.doc.lineAt(mark.from)).
//   - HIDE = Decoration.replace over [mark.from, mark.to + structural-
//     whitespace) — review fix #5 absorbs ALL consecutive space/tab
//     characters (Codex H1) so `>\tquote` and `>  quote` also hide
//     cleanly, not just the single-space `> quote`.
//   - REVEAL = Decoration.mark over [mark.from, mark.to) with the
//     "quoll-syntax-reveal" class.
//
// Nested `> >` produces multiple QuoteMark nodes on the same line; each
// is decorated independently against the same line range — they share
// the reveal/hide decision because they share the line.

import { RangeSetBuilder } from "@codemirror/state";
import type { Decoration } from "@codemirror/view";

import { absorbStructuralWhitespace, HIDE, intersectsAnySelection, REVEAL_MARK } from "./shared.js";
import type { DecorationProvider } from "./types.js";

export const blockquoteReveal: DecorationProvider = {
  build(ctx) {
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (node.name !== "QuoteMark") {
            return;
          }
          const line = ctx.state.doc.lineAt(node.from);
          const revealed = intersectsAnySelection(ctx.selection, line.from, line.to);
          if (revealed) {
            builder.add(node.from, node.to, REVEAL_MARK);
          } else {
            const hideTo = absorbStructuralWhitespace(ctx.state, node.to);
            builder.add(node.from, hideTo, HIDE);
          }
        },
      });
    }
    return builder.finish();
  },
};
