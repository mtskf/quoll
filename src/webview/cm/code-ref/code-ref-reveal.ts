// DecorationProvider: over each visible InlineCode whose interior parses as a
// workspace-relative code reference (parseInlineCodeReference), emit a
// `quoll-code-ref-clickable` mark. Skipped inside a Link (the Link owns the
// click) or while the selection intersects the span (editing).

import { Decoration, type DecorationSet } from "@codemirror/view";

import { intersectsAnySelection } from "../decorations/shared.js";
import type { DecorationProvider } from "../decorations/types.js";
import { buildSortedRangeSet } from "../sorted-range-set.js";
import { hasLinkAncestor, inlineCodeInterior } from "./inline-code-ref.js";
import { parseInlineCodeReference } from "./parse-code-reference.js";

// `role="link"` makes the reference discoverable to assistive tech as an
// actionable control (its accessible name comes from the reference text itself,
// e.g. "src/foo.ts:42"); `title` gives sighted mouse users a hover hint. The
// keyboard-operable path is the Mod-Enter command in code-ref-handlers.ts — the
// span is not Tab-focusable (Chromium does not Tab into inline marks inside the
// CM contenteditable; same constraint as the task-checkbox widget).
const CLICKABLE = Decoration.mark({
  class: "quoll-code-ref-clickable",
  attributes: { role: "link", title: "Open referenced file" },
});

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
