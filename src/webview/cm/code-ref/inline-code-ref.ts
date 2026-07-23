// Shared Lezer walks for inline-code references, used by BOTH the decoration
// resolver (code-ref-reveal.ts) and the click handler (code-ref-handlers.ts).
// Centralising them keeps the reveal decoration and the click gate in lockstep:
// the two must agree on which InlineCode nodes are clickable, so they walk the
// tree the same way. Typed to accept `SyntaxNodeRef` (via `.node`) so both the
// iterate callback (SyntaxNodeRef) and the resolveInner walk (SyntaxNode) fit.

import type { SyntaxNodeRef } from "@lezer/common";

/** True when `node` sits inside a Link (the Link owns the click, so a code
 *  reference inside it is NOT independently clickable). */
export function hasLinkAncestor(node: SyntaxNodeRef): boolean {
  let p = node.node.parent;
  while (p !== null) {
    if (p.name === "Link") {
      return true;
    }
    p = p.parent;
  }
  return false;
}

/** The interior span of an InlineCode node — between the first and last
 *  `CodeMark` (backtick) children, exclusive of the marks. Returns null when the
 *  node has no children or no non-empty interior between marks. */
export function inlineCodeInterior(node: SyntaxNodeRef): { from: number; to: number } | null {
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
