import { highlightingFor } from "@codemirror/language";
import { Decoration } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { highlightTree } from "@lezer/highlight";
import { decodeNumericEntity } from "../../../markdown/numeric-entity.js";
import { buildSortedRangeSet } from "../sorted-range-set.js";
import { NumericEntityWidget } from "./numeric-entity-widget.js";
import { intersectsAnySelection, REVEAL_MARK } from "./shared.js";
import type { DecorationProvider } from "./types.js";

function displayable(text: string): boolean {
  const cp = text.codePointAt(0) ?? 0;
  return !(
    cp <= 0x1f ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

function isInsideImage(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "Image") {
      return true;
    }
  }
  return false;
}

export const numericEntityReveal: DecorationProvider = {
  build(ctx) {
    const out: Array<{
      from: number;
      to: number;
      text: string;
      classes: Set<string>;
      revealed: boolean;
    }> = [];
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter(node) {
          if (node.name !== "Entity" || node.from >= range.to || range.from >= node.to) {
            return;
          }
          if (isInsideImage(node.node)) {
            return;
          }
          const text = decodeNumericEntity(ctx.state.sliceDoc(node.from, node.to));
          if (text === null || !displayable(text)) {
            return;
          }
          out.push({
            from: node.from,
            to: node.to,
            text,
            classes: new Set(),
            revealed: intersectsAnySelection(ctx.selection, node.from, node.to),
          });
        },
      });
    }
    // The classes the active highlighters assign to each entity's source text,
    // inherited emphasis included — the same walk syntaxHighlighting() runs. One
    // walk per visible range, over only that range's entities (not one per entity,
    // and never across the folded gap between ranges), keeps the build linear.
    out.sort((a, b) => a.from - b.from);
    for (const range of ctx.visibleRanges) {
      const entries = out.filter((e) => e.from < range.to && range.from < e.to);
      if (entries.length === 0) {
        continue;
      }
      let next = 0;
      highlightTree(
        ctx.tree,
        { style: (tags) => highlightingFor(ctx.state, tags) },
        (from, to, cls) => {
          while (next < entries.length && entries[next].to <= from) {
            next++;
          }
          for (let i = next; i < entries.length && entries[i].from < to; i++) {
            for (const c of cls.split(" ")) {
              if (c) {
                entries[i].classes.add(c);
              }
            }
          }
        },
        entries[0].from,
        entries[entries.length - 1].to
      );
    }
    return buildSortedRangeSet(out, (entry) => [
      entry.from,
      entry.to,
      entry.revealed
        ? REVEAL_MARK
        : Decoration.replace({
            widget: new NumericEntityWidget(entry.text, [...entry.classes].join(" ")),
          }),
    ]);
  },
};
