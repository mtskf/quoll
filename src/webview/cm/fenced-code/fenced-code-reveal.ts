// Fenced-code FENCE-mark reveal. The companion to block-style.ts: that module
// paints the code panel on every line of a FencedCode node (via Decoration.line
// markers) but deliberately never touches the ``` fence markers — concealing
// them is THIS provider's job, mirroring how blockquote-reveal hides the `>`
// while block-style paints the quote rule.
//
// Walks each FencedCode node and decorates its CodeMark CHILDREN (the opening
// and, when the block is closed, the closing ```). Scoping to FencedCode's own
// children — rather than matching the bare `CodeMark` node name — is essential:
// InlineCode also emits CodeMark children, and those are inline-mark-reveal's
// concern. An unclosed block at EOF has a single CodeMark; iterating the
// children handles 1-or-2 fences uniformly.
//
// Per CodeMark:
//   - Reveal-trigger = the caret intersecting the FencedCode node's FULL line span
//     (fencedCodeBlockRevealed, shared with block-style.ts). Entering the block —
//     including a caret in the code body — reveals BOTH fences so the ```lang tag
//     and closing ``` can be edited; leaving the block re-conceals them. (Heading/
//     blockquote reveal stays per-line because their marker shares its content line;
//     a fence's ``` lives on its own line, so a body caret must still reach it.)
//   - HIDE = Decoration.replace over [mark.from, line.to). For the opening fence
//     the line is `\`\`\`lang` — the whole structural line — so hiding to the
//     line end also absorbs the CodeInfo language tag (there is no body content
//     to keep, unlike heading's `# Heading`). Starting at mark.from (not
//     line.from) leaves any blockquote `> ` prefix to blockquote-reveal, so the
//     two providers tile a `> \`\`\`` fence line without overlapping replaces.
//   - REVEAL = Decoration.mark over [mark.from, mark.to) (the ``` only) with the
//     shared "quoll-syntax-reveal" dim class; the language tag then shows in its
//     normal CodeInfo token colour, exactly like editing raw source.
//
// Decoration-only: the document bytes are never mutated, so the source ``` lines
// round-trip identically.

import { RangeSetBuilder } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";

import { fencedCodeBlockRevealed } from "./fenced-code-body.js";
import { HIDE, REVEAL_MARK } from "../decorations/shared.js";
import type { DecorationProvider } from "../decorations/types.js";

export const fencedCodeReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    // Collected flat first so we can SORT before building: a FencedCode's
    // opening fence HIDE starts at mark.from while a later node is visited in
    // document order, but emitting the close mark of one block before the open
    // mark of the next stays monotonic only after an explicit sort — cheaper
    // to sort unconditionally than to reason about every nesting case.
    const out: Array<{ from: number; to: number; revealed: boolean }> = [];
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (node.name !== "FencedCode") {
            return;
          }
          // Block-scoped reveal: a caret ANYWHERE in the block reveals BOTH fences
          // (per-fence-line left them hidden when the caret sat in the body). One
          // predicate, shared with block-style.ts's row-collapse, so mark reveal and
          // row collapse never disagree.
          const revealed = fencedCodeBlockRevealed(ctx.state.doc, ctx.selection, node.node);
          const child = node.node.cursor();
          if (!child.firstChild()) {
            return;
          }
          do {
            if (child.name !== "CodeMark") {
              continue;
            }
            const markFrom = child.from;
            const markTo = child.to;
            // visibleRange overlap check (parity with heading/inline-mark): a
            // tall FencedCode can straddle the viewport edge so one fence mark
            // sits off-screen even though the node overlaps the window. The
            // child cursor is unbounded, so guard each mark explicitly.
            if (!(markFrom < range.to && range.from < markTo)) {
              continue;
            }
            // HIDE still absorbs the opening fence's CodeInfo language tag by
            // extending to line end; only the reveal DECISION is now block-scoped.
            const line = ctx.state.doc.lineAt(markFrom);
            out.push({
              from: markFrom,
              to: revealed ? markTo : line.to,
              revealed,
            });
          } while (child.nextSibling());
        },
      });
    }
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<Decoration>();
    for (const entry of out) {
      builder.add(entry.from, entry.to, entry.revealed ? REVEAL_MARK : HIDE);
    }
    return builder.finish();
  },
};
