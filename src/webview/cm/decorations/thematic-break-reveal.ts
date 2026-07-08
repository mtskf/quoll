// Thematic-break (horizontal rule) reveal. Walks the Lezer GFM tree for
// `HorizontalRule` nodes and, per node, emits ONE inline decoration keyed to
// whether a selection range intersects the node's LINE (the reveal trigger,
// mirroring heading-/blockquote-reveal):
//   - caret OFF the line  → Decoration.replace({ widget: ThematicBreakWidget })
//     over [replaceFrom, line.to] — hides the raw `---`/`***`/`___` and renders
//     a rule. replaceFrom absorbs a leading INDENT (a break may be indented up
//     to 3 spaces and Lezer's node starts AFTER the indent) but PRESERVES a
//     container prefix (`> ---`): a pure-whitespace gap before the node is
//     indent → start at line.from; a non-whitespace gap is a quote marker →
//     start at node.from so the blockquote prefix survives. When the
//     whitespace indent is a LIST-ITEM continuation (`- x\n\n  ---`), the
//     widget is additionally inset one prose-space per source column so the
//     rule aligns to the item's content column (matching the sibling nested
//     paragraph) instead of the document margin.
//   - caret ON the line   → Decoration.mark (REVEAL_MARK, `quoll-syntax-reveal`)
//     over the node span [node.from, node.to] — dims the raw glyphs in place so
//     they stay editable, exactly like the other reveals.
//
// Scope guard — match ONLY a real `HorizontalRule` node:
//   - A SETEXT heading underline (`text\n---`) parses as SetextHeading2 +
//     HeaderMark, NOT HorizontalRule, so it never matches here.
//   - The FRONTMATTER opener `---` DOES parse as a HorizontalRule at [0,3], but
//     `frontmatterBlockField` publishes the frontmatter span to
//     `quollSyntaxExclusionZones`, and the orchestrator's `arbitrate` drops any
//     inline decoration overlapping that zone. So the opener replace [0,3] is
//     suppressed by the SAME mechanism every other inline reveal uses — this
//     provider deliberately does NOT re-implement frontmatter detection. A lone
//     `---` at doc top with no closing fence is not frontmatter (detect.ts
//     requires a closer) → no zone → it renders as a real rule.
//
// Display-only: build() never mutates the document; bytes round-trip.

import { countColumn, RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

import { intersectsAnySelection, REVEAL_MARK } from "./shared.js";
import { ThematicBreakWidget } from "./thematic-break-widget.js";
import type { DecorationProvider } from "./types.js";

export const thematicBreakReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (node.name !== "HorizontalRule") {
            return;
          }
          const line = ctx.state.doc.lineAt(node.from);
          // Viewport-edge guard (parity with heading-reveal): tree.iterate
          // visits any node OVERLAPPING the window, but we anchor on the whole
          // line, which can extend past the window edge. Only emit when the
          // line span overlaps this visible range.
          if (!(line.from < range.to && range.from < line.to)) {
            return;
          }
          if (intersectsAnySelection(ctx.selection, line.from, line.to)) {
            // Reveal: dim the raw glyphs at the NODE span. Guard the node range
            // (not just the line) against the window — an indented `   ---` has
            // its node start AFTER the indent, so a viewport edge falling between
            // line.from and node.from would otherwise emit this mark entirely
            // outside the window. Parity with heading-reveal, which guards the
            // exact decorated range, not merely the reveal-trigger line.
            if (node.from < range.to && range.from < node.to) {
              builder.add(node.from, node.to, REVEAL_MARK);
            }
          } else {
            // Absorb a leading INDENT into the replace (a thematic break may be
            // indented up to 3 spaces, and the widget renders the whole visual
            // line as one rule). But when the break sits inside a CONTAINER
            // (`> ---`), the gap between line.from and node.from is the quote
            // marker, not indent — replacing it would conceal the `> ` prefix
            // and lift the rule out of its blockquote. Start the replace at
            // node.from there so blockquote-reveal / block-style still render
            // the container. Distinguish the two by the gap's content: pure
            // whitespace → indent (absorb from line.from); anything else →
            // structural prefix (preserve, start at node.from). `- ---` is a
            // real HR whose `-` is a rule glyph, so its gap is empty → absorbed.
            const prefix = ctx.state.doc.sliceString(line.from, node.from);
            const whitespaceGap = /^\s*$/.test(prefix);
            const from = whitespaceGap ? line.from : node.from;
            // A whitespace gap that indents the break inside a LIST ITEM
            // (`- x\n\n  ---`) is continuation indent, not a top-level indent:
            // render the rule at the item's content column — like the sibling
            // nested paragraph, which shows its literal leading spaces — by
            // insetting the widget one prose-space per source column. A
            // TOP-LEVEL indent (`   ---`) keeps indentCols 0 (absorbed to the
            // margin, unchanged); a container prefix (`> ---`) already took the
            // node.from branch above and also keeps indentCols 0. The gap's
            // characters alone can't tell list-continuation from top-level
            // indent — that needs the enclosing ListItem node context.
            let indentCols = 0;
            if (whitespaceGap) {
              for (let p = node.node.parent; p; p = p.parent) {
                if (p.name === "ListItem") {
                  indentCols = countColumn(prefix, ctx.state.tabSize);
                  break;
                }
              }
            }
            builder.add(
              from,
              line.to,
              Decoration.replace({ widget: new ThematicBreakWidget(indentCols) })
            );
          }
        },
      });
    }
    return builder.finish();
  },
};
