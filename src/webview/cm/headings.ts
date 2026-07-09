// Single ATX-heading collector shared by the outline builder and the
// heading-increment / duplicate-heading-text lint rules. Each consumer did its
// own `tree.iterate` over the same `ATXHeading{1..6}` match; this is that walk,
// once. Consumers add their own per-heading work (text slice, ancestor-depth
// stack) on top of the returned {level, from, to} list. The Tree type is derived
// from syntaxTree's return type per repo convention (avoids widening the
// @lezer/common direct-dep import surface — see decorations/types.ts).

import type { syntaxTree } from "@codemirror/language";

type Tree = ReturnType<typeof syntaxTree>;

/** Matches Lezer `ATXHeading1`..`ATXHeading6`, capturing the level digit.
 *  Module-private: consumers import `collectHeadings`, not the regex. */
const ATX_HEADING = /^ATXHeading([1-6])$/;

/** Walk `tree` for ATX headings in document order, returning each heading's
 *  level (1..6) and node span `[from, to)`. Descends into every block so
 *  headings nested in blockquotes / list items are included. */
export function collectHeadings(tree: Tree): { level: number; from: number; to: number }[] {
  const headings: { level: number; from: number; to: number }[] = [];
  tree.iterate({
    enter: (node) => {
      const m = ATX_HEADING.exec(node.name);
      if (m) {
        headings.push({ level: Number(m[1]), from: node.from, to: node.to });
      }
    },
  });
  return headings;
}
