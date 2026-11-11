import { highlightingFor } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import type { Tree } from "@lezer/common";
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

// The classes the active highlighters assign to [from, to), inherited emphasis
// included — the same walk syntaxHighlighting() runs for the source text.
function highlightClassAt(state: EditorState, tree: Tree, from: number, to: number): string {
  const classes = new Set<string>();
  highlightTree(
    tree,
    { style: (tags) => highlightingFor(state, tags) },
    (_from, _to, cls) => {
      for (const c of cls.split(" ")) {
        if (c) {
          classes.add(c);
        }
      }
    },
    from,
    to
  );
  return [...classes].join(" ");
}

export const numericEntityReveal: DecorationProvider = {
  build(ctx) {
    const out: Array<{
      from: number;
      to: number;
      text: string;
      highlightClass: string;
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
          for (let parent = node.node.parent; parent; parent = parent.parent) {
            if (parent.name === "Image") {
              return;
            }
          }
          const text = decodeNumericEntity(ctx.state.sliceDoc(node.from, node.to));
          if (text === null || !displayable(text)) {
            return;
          }
          out.push({
            from: node.from,
            to: node.to,
            text,
            highlightClass: highlightClassAt(ctx.state, ctx.tree, node.from, node.to),
            revealed: intersectsAnySelection(ctx.selection, node.from, node.to),
          });
        },
      });
    }
    return buildSortedRangeSet(out, (entry) => [
      entry.from,
      entry.to,
      entry.revealed
        ? REVEAL_MARK
        : Decoration.replace({ widget: new NumericEntityWidget(entry.text, entry.highlightClass) }),
    ]);
  },
};
