// DecorationProvider: over each visible InlineCode whose interior parses as a
// workspace-relative code reference (parseInlineCodeReference), emit a
// `quoll-code-ref-clickable` mark. Skipped inside a Link (the Link owns the
// click) or while the selection intersects the span (editing).

import { Decoration, type DecorationSet } from "@codemirror/view";
import type { SyntaxNodeRef } from "@lezer/common";

import { intersectsAnySelection } from "../decorations/shared.js";
import type { DecorationProvider } from "../decorations/types.js";
import { buildSortedRangeSet } from "../sorted-range-set.js";
import { parseInlineCodeReference } from "./parse-code-reference.js";

const CLICKABLE = Decoration.mark({ class: "quoll-code-ref-clickable" });

function inlineCodeInterior(node: SyntaxNodeRef): { from: number; to: number } | null {
  const cur = node.node.cursor();
  if (!cur.firstChild()) {
    return null;
  }
  let firstMarkTo: number | null = null;
  let lastMarkFrom: number | null = null;
  do {
    if (cur.name === "CodeMark") {
      if (firstMarkTo === null) {
        firstMarkTo = cur.to;
      }
      lastMarkFrom = cur.from;
    }
  } while (cur.nextSibling());
  if (firstMarkTo === null || lastMarkFrom === null || firstMarkTo >= lastMarkFrom) {
    return null;
  }
  return { from: firstMarkTo, to: lastMarkFrom };
}

function hasLinkAncestor(node: SyntaxNodeRef): boolean {
  let p = node.node.parent;
  while (p !== null) {
    if (p.name === "Link") {
      return true;
    }
    p = p.parent;
  }
  return false;
}

export const codeRefReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    const out: Array<{ from: number; to: number; deco: Decoration }> = [];
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (node.name !== "InlineCode" || hasLinkAncestor(node)) {
            return;
          }
          const interior = inlineCodeInterior(node);
          if (interior === null) {
            return;
          }
          const text = ctx.state.doc.sliceString(interior.from, interior.to);
          if (parseInlineCodeReference(text) === null) {
            return;
          }
          if (intersectsAnySelection(ctx.selection, node.from, node.to)) {
            return;
          }
          if (interior.from < range.to && range.from < interior.to) {
            out.push({ from: interior.from, to: interior.to, deco: CLICKABLE });
          }
        },
      });
    }
    return buildSortedRangeSet(out, (entry) => [entry.from, entry.to, entry.deco]);
  },
};
