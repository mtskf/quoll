// Inline-mark syntax-token reveal. Walks the Lezer GFM tree and emits one
// decoration per child mark node of each inline-span construct:
//
//   - StrongEmphasis  → EmphasisMark   (two `**`)
//   - Emphasis        → EmphasisMark   (two `*` or `_`)
//   - InlineCode      → CodeMark       (two `` ` ``, or `` `` ``, etc.)
//   - Strikethrough   → StrikethroughMark (two `~~`) — GFM
//
// Per construct, if ANY selection range intersects the outer span node,
// every mark child REVEALS (Decoration.mark .quoll-syntax-reveal); otherwise
// every mark child HIDES (Decoration.replace).
//
// Nested constructs (Strong > Emphasis) are handled naturally by walking
// the tree: each construct decides independently against its own outer
// span, so caret-in-inner reveals BOTH outer and inner (because the inner
// span is fully contained in the outer's range; the selection-intersect
// test on each node fires the same way).
//
// No structural-whitespace absorption (review fix #5) — inline marks abut
// the content directly. Heading/blockquote are the only constructs where
// the syntactic prefix has a semantic space.

import { RangeSetBuilder } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";

import { HIDE, intersectsAnySelection, REVEAL_MARK } from "./shared.js";
import type { DecorationProvider } from "./types.js";

// Outer span → expected child mark name(s). A construct may have multiple
// mark-node names if Lezer ever splits open/close marks differently; the
// set form future-proofs the lookup.
const SPAN_TO_MARK: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["StrongEmphasis", new Set(["EmphasisMark"])],
  ["Emphasis", new Set(["EmphasisMark"])],
  ["InlineCode", new Set(["CodeMark"])],
  ["Strikethrough", new Set(["StrikethroughMark"])],
]);

export const inlineMarkReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    // Collected as a flat array first so we can SORT before adding to the
    // RangeSetBuilder — Lezer's tree-iterate is pre-order DFS, so nested
    // child marks are visited between their parent's open and close marks,
    // which violates RangeSetBuilder's "from must be non-decreasing"
    // contract.
    const out: Array<{ from: number; to: number; revealed: boolean }> = [];
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          const markNames = SPAN_TO_MARK.get(node.name);
          if (markNames === undefined) {
            return;
          }
          const revealed = intersectsAnySelection(ctx.selection, node.from, node.to);
          const sub = node.node.cursor();
          if (!sub.firstChild()) {
            return;
          }
          do {
            if (markNames.has(sub.name)) {
              // visibleRange overlap check (review fix #9, Codex Conf 98):
              // The outer span may straddle the viewport edge — e.g.
              // StrongEmphasis [50, 70) over viewport [40, 65) — and the
              // closing EmphasisMark at [68, 70) sits OUTSIDE the viewport.
              // Drop it; the Task 10 functional contract reds otherwise.
              if (sub.from < range.to && range.from < sub.to) {
                out.push({ from: sub.from, to: sub.to, revealed });
              }
            }
          } while (sub.nextSibling());
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
