// DecorationProvider: over each visible InlineCode whose interior parses as a
// workspace-relative code reference (parseInlineCodeReference), emit a
// `quoll-code-ref-clickable` mark. Skipped inside a Link (the Link owns the
// click) or while a non-empty selection intersects the span (editing).

import { Decoration, type DecorationSet } from "@codemirror/view";

import type { DecorationProvider } from "../decorations/types.js";
import { buildSortedRangeSet } from "../sorted-range-set.js";
import { hasLinkAncestor, inlineCodeInterior } from "./inline-code-ref.js";
import { parseInlineCodeReference } from "./parse-code-reference.js";

// `role="link"` makes the reference discoverable to assistive tech as an
// actionable control (its accessible name comes from the reference text itself,
// e.g. "src/foo.ts:42"); `aria-keyshortcuts` + the `title` hint announce the
// activation gesture (there is no plain-Enter link activation here — see below).
// Activation paths: a screen-reader/AT "click" on the announced link (handled by
// the click domEventHandler in code-ref-handlers.ts), the Mod-Enter caret command,
// and the mouse. This span carries no tabindex, so it is not Tab-focusable;
// whether adding one would work on a Decoration.mark inside CM's contenteditable
// is unverified (the task-checkbox widget sets tabIndex=0 on a Decoration.replace
// widget and still did not get real Tab traversal — a different, narrower case).
const CLICKABLE = Decoration.mark({
  class: "quoll-code-ref-clickable",
  attributes: {
    role: "link",
    title: "Open referenced file (Cmd/Ctrl+Enter)",
    "aria-keyshortcuts": "Meta+Enter Control+Enter",
  },
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
          // Suppress only during a real (non-empty) selection over the span —
          // NOT a bare caret. The Mod-Enter command (code-ref-handlers.ts) acts on
          // a caret inside the reference, so suppressing on a caret would make the
          // role="link" cue and the keyboard command mutually exclusive.
          if (
            ctx.selection.ranges.some((r) => !r.empty && r.from <= node.to && r.to >= node.from)
          ) {
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
