// Classify a Markdown document with the shared GFM parser into byte-untouched
// protected ranges, Table node ranges, and ordered-list marker groups, in ONE
// tree.iterate walk (enter returns false to skip descent — the precedent is
// cm/table/table-ranges.ts; a manual cursor walk leaks adjacent protected
// blocks). Frontmatter is detected by its opening/closing --- fences (NOT
// validateFrontmatter, which rejects any block containing a bare ---). Tables
// are the parser's Table nodes (filtered against protected ranges), NOT the
// line-based parseAllTables (which absorbs interrupters / includes list
// markers — see Decision Log).
import { FENCE_LINE } from "../frontmatter.js";
import { gfmParser } from "../gfm-parser.js";

const PROTECTED_NODES: ReadonlySet<string> = new Set([
  "FencedCode",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
]);

export type Range = { from: number; to: number };
export type ListMarkInfo = { from: number; to: number; text: string };
export type OrderedList = { marks: ListMarkInfo[] };
export type DocClassification = {
  protectedRanges: Range[];
  tableRanges: Range[];
  orderedLists: OrderedList[];
};

export function rangesIntersect(ranges: readonly Range[], from: number, to: number): boolean {
  return ranges.some((r) => r.from < to && from < r.to);
}

function frontmatterRange(source: string): Range | null {
  const lines = source.split(/(?<=\n)/); // keep terminators
  if (lines.length === 0 || !FENCE_LINE.test(lines[0].replace(/\n$/, ""))) {
    return null;
  }
  let end = lines[0].length;
  for (let i = 1; i < lines.length; i++) {
    end += lines[i].length;
    if (FENCE_LINE.test(lines[i].replace(/\n$/, ""))) {
      return { from: 0, to: end }; // closing fence found
    }
  }
  return null; // no closing fence -> not frontmatter
}

export function classifyDocument(source: string): DocClassification {
  const protectedRanges: Range[] = [];
  const tableRanges: Range[] = [];
  const orderedLists: OrderedList[] = [];

  const fm = frontmatterRange(source);
  if (fm) {
    protectedRanges.push(fm);
  }

  const tree = gfmParser.parse(source);
  tree.iterate({
    enter: (node) => {
      if (PROTECTED_NODES.has(node.name)) {
        protectedRanges.push({ from: node.from, to: node.to });
        return false; // do not descend into protected content
      }
      if (node.name === "Table") {
        // Parser is the authority for table extent/membership. Exclude a table
        // that intersects a protected range (frontmatter is pushed above before
        // the walk, so a pipe-table inside YAML is filtered here).
        if (!rangesIntersect(protectedRanges, node.from, node.to)) {
          tableRanges.push({ from: node.from, to: node.to });
        }
        return false; // GFM tables don't nest; cells not needed
      }
      if (node.name === "OrderedList") {
        const marks: ListMarkInfo[] = [];
        for (let item = node.node.firstChild; item; item = item.nextSibling) {
          if (item.name !== "ListItem") {
            continue;
          }
          const mark = item.firstChild;
          if (mark && mark.name === "ListMark") {
            marks.push({ from: mark.from, to: mark.to, text: source.slice(mark.from, mark.to) });
          }
        }
        if (marks.length > 0 && !rangesIntersect(protectedRanges, node.from, node.to)) {
          orderedLists.push({ marks });
        }
        return true; // descend so nested ordered lists are visited
      }
      return undefined;
    },
  });

  return { protectedRanges, tableRanges, orderedLists };
}
