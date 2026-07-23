// DecorationProvider: over each visible InlineCode whose interior parses as a
// workspace-relative code reference (parseInlineCodeReference), emit a
// `quoll-code-ref-clickable` mark. Skipped only inside a Link (the Link owns the
// click). The affordance is selection-independent: unlike the syntax-reveal
// providers (which reveal raw markdown when the caret enters, so they suppress on
// selection), this mark is purely additive — the inline-code text always renders
// as-is, and the mark only adds the underline + role/name. Suppressing it on a
// caret would strip the role="link" cue exactly where the Mod-Enter command
// (code-ref-handlers.ts) is invoked, so it is never suppressed by selection.

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
          if (interior.from < range.to && range.from < interior.to) {
            out.push({ from: interior.from, to: interior.to, deco: CLICKABLE });
          }
        },
      });
    }
    return buildSortedRangeSet(out, (entry) => [entry.from, entry.to, entry.deco]);
  },
};
