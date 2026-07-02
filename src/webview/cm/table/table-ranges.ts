// The ONE Lezer `Table`-node walk used by table-skeleton.ts's `tableSkeletonField`
// to collect document-ordered Table ranges. Table detection, descendant-skip, and
// range semantics live in exactly one place so they can never drift.
// Pure: a lazy reader of the passed tree, no field/state dependency, so nothing in
// the table dir forms an import cycle around it. Typed via
// `ReturnType<typeof syntaxTree>` to avoid a direct `@lezer/common` dependency
// (the repo only depends on @lezer/highlight + @lezer/markdown).
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
