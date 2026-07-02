// Heading syntax-token reveal. Walks the Lezer GFM tree and emits one
// decoration per ATX heading's HeaderMark child:
//   - Decoration.replace over [mark.from, mark.to + structural-whitespace)
//     when no selection range intersects the heading LINE (HIDDEN). The
//     whitespace absorption (review fix #5) prevents a phantom indent and
//     consumes ALL consecutive spaces/tabs (Codex H1) so `#  Heading`
//     (double space — valid CommonMark) also hides cleanly.
//   - Decoration.mark over [mark.from, mark.to) (mark-exact, no trailing
//     space) with class "quoll-syntax-reveal" otherwise (DIM).
//
// Reveal-trigger range is the heading LINE (state.doc.lineAt(node.from)) —
// per-line, NOT the whole construct (which IS a single line for ATX, so
// this is equivalent; documenting the rule explicitly so it stays correct
// if Lezer ever changes the node bounds).
//
// Setext headings (==== / ---- underlines) are out of scope by user-prompt
// — no `#` mark to reveal.

import { RangeSetBuilder } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";

import { absorbStructuralWhitespace, HIDE, intersectsAnySelection, REVEAL_MARK } from "./shared.js";
import type { DecorationProvider } from "./types.js";

const ATX_HEADING_PARENT = new Set([
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
]);

export const headingReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (!ATX_HEADING_PARENT.has(node.name)) {
            return;
          }
          const line = ctx.state.doc.lineAt(node.from);
          const revealed = intersectsAnySelection(ctx.selection, line.from, line.to);
          // ONLY decorate the LEADING HeaderMark (review fix #22). Lezer
          // emits the trailing `#` of `# heading #` as a HeaderMark child
          // too, but the user-prompt UX is "leading `#` group is
          // dim-revealed" — the closing marker is plain markdown text, not
          // a syntax-reveal target. ATX-heading's first child IS the
          // leading HeaderMark, so a one-shot firstChild() lookup is
          // enough; no sibling loop.
          const cursor = node.node.cursor();
          if (!cursor.firstChild()) {
            return;
          }
          if (cursor.name !== "HeaderMark") {
            return;
          }
          const markFrom = cursor.from;
          const markTo = revealed ? cursor.to : absorbStructuralWhitespace(ctx.state, cursor.to);
          // visibleRange overlap check (review fix #9, Codex Conf 98):
          // `tree.iterate({from, to})` visits nodes whose range OVERLAPS
          // the supplied window, but cursor.firstChild() is unbounded.
          // A heading whose line straddles the viewport edge would
          // otherwise emit a HeaderMark sitting outside the visible range.
          // Task 10's functional contract reds against any out-of-window
          // emit.
          if (markFrom < range.to && range.from < markTo) {
            builder.add(markFrom, markTo, revealed ? REVEAL_MARK : HIDE);
          }
        },
      });
    }
    return builder.finish();
  },
};
