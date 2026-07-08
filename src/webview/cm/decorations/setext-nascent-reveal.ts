// Setext "nascent list" reveal. A lone `-` (or `=`) typed on the line directly
// under a paragraph makes CommonMark parse the pair as a SetextHeading (the `-`
// is the underline, HeaderMark), so `quollHighlighting` (theme.ts) styles the
// paragraph big/bold/navy — surprising when the user is actually starting a
// bullet list, not authoring a heading. heading-reveal.ts is ATX-only (no `#`
// mark to reveal for setext), so nothing else de-styles it.
//
// This provider walks SetextHeading1/2 nodes and, when the underline is a LONE
// marker (a SINGLE `-`/`=`, ignoring the parser-excluded trailing whitespace),
// emits ONE Decoration.mark over the whole heading node carrying
// `quoll-setext-nascent-raw`. The CSS resets the span (and every syntax-
// highlight child span it wraps) back to body font-size / weight / colour so the
// paragraph reads as plain text with a nascent bullet marker under it.
//
// CARET-INDEPENDENT (unlike the sibling caret-driven reveals): a lone `-`/`=`
// reads as a list-in-progress whether or not the caret is on it. A caret-gated
// version would flicker — plain while typing the `-`, then ballooning into a
// heading the instant the caret moves away — which is more jarring than the bug.
//
// Two known, deliberate limitations (tracked as follow-ups in docs/TODO.md):
//   1. The de-style resets FONT only. A nascent setext still gets heading-rhythm
//      top padding (heading-rhythm.ts) and a fold chevron (markdown.ts's heading
//      foldService), which key off the SetextHeading node type — so the paragraph
//      no longer LOOKS like a heading but keeps a heading's spacing/gutter
//      affordances. A complete demotion needs a shared "lone-setext" predicate in
//      those consumers too.
//   2. Inline emphasis inside the paragraph (`Foo **bar**` then `-`) is flattened
//      to plain along with the heading look — CodeMirror combines the heading and
//      emphasis tags on one span, so the CSS reset (styles.css) can't spare the
//      emphasis. See that rule's comment for the trade-off rationale.
//
// Scope — deliberately NARROW so genuine headings are untouched:
//   - MULTI-char underlines (`--`, `---`, `===`) read as an intentional heading
//     → never matched (the lone-marker gate below). Only a SINGLE `-`/`=` — the
//     shape the user types en route to a bullet list — is demoted.
//   - Frontmatter: a `title: x`/`---` pair parses as SetextHeading2 under plain
//     Lezer, but frontmatterBlockField publishes its span to
//     quollSyntaxExclusionZones and the orchestrator's arbitrate() drops any
//     inline decoration overlapping that zone — so this provider needs no
//     frontmatter detection of its own (same mechanism thematic-break-reveal
//     relies on). (A frontmatter underline is `---`, multi-char, anyway.)
//
// Display-only: build() never mutates the document; bytes round-trip.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

import type { DecorationProvider } from "./types.js";

/** CSS class applied to a de-styled nascent-setext heading node. The
 *  styles.css rule is the consumer; renaming requires updating both this const
 *  and the CSS in lockstep (pinned by styles-contract.test.ts). */
export const SETEXT_NASCENT_CLASS = "quoll-setext-nascent-raw";

const SETEXT_NASCENT_MARK = Decoration.mark({ class: SETEXT_NASCENT_CLASS });

const SETEXT_HEADING = new Set(["SetextHeading1", "SetextHeading2"]);

export const setextNascentReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (!SETEXT_HEADING.has(node.name)) {
            return;
          }
          // The underline is the heading's HeaderMark child (setext marks only
          // the underline, never the title). A lone marker is a SINGLE `-`/`=`
          // — the trailing space of a mid-typing `- ` is not part of the mark,
          // so `Foo\n- ` still reads as lone. `--`/`---`/`===` are multi-char.
          const mark = node.node.lastChild;
          if (!mark || mark.name !== "HeaderMark" || mark.to - mark.from !== 1) {
            return;
          }
          // Viewport-edge guard (parity with heading-reveal): tree.iterate
          // visits any node OVERLAPPING the window, so only emit when the node
          // span overlaps this visible range.
          if (node.from < range.to && range.from < node.to) {
            builder.add(node.from, node.to, SETEXT_NASCENT_MARK);
          }
        },
      });
    }
    return builder.finish();
  },
};
