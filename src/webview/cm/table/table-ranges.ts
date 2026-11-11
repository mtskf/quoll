// A Lezer `Table`-node walk collecting document-ordered Table ranges, for the
// lint rule lint/rules/table-column-count.ts. The table block widgets do not use it:
// their walk is the structural block contract's (../structural-blocks.ts).
// Pure: a lazy reader of the passed tree, no field/state dependency, so nothing in
// the table dir forms an import cycle around it. Typed via
// `ReturnType<typeof syntaxTree>` to avoid a direct `@lezer/common` import
// (it is a direct dep as of PR #66, but deriving the type keeps the direct-dep
// import surface narrow).
import type { syntaxTree } from "@codemirror/language";

/** Every `Table` node range overlapping [from,to] (whole tree when from/to
 *  omitted), in document order, descendants skipped (GFM tables don't nest). */
export function collectTableRanges(
  tree: ReturnType<typeof syntaxTree>,
  from?: number,
  to?: number
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (node.name === "Table") {
        out.push({ from: node.from, to: node.to });
        return false;
      }
    },
  });
  return out;
}
