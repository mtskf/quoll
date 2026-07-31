// Classify a Markdown document with the shared GFM parser into byte-untouched
// protected ranges, Table node ranges, and ordered-list marker groups, in ONE
// tree.iterate walk (enter returns false to skip descent — the precedent is
// cm/table/table-ranges.ts; a manual cursor walk leaks adjacent protected
// blocks). Frontmatter is detected by its opening/closing --- fences (NOT
// validateFrontmatter, which rejects any block containing a bare ---). Tables
// are the parser's Table nodes (filtered against protected ranges), NOT the
// line-based parseAllTables (which absorbs interrupters / includes list
// markers — see Decision Log).
import type { SyntaxNode } from "@lezer/common";
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
export type BulletList = { marks: ListMarkInfo[]; adjacencySafe: boolean };
export type DocClassification = {
  protectedRanges: Range[];
  tableRanges: Range[];
  orderedLists: OrderedList[];
  bulletLists: BulletList[];
};

export function rangesIntersect(ranges: readonly Range[], from: number, to: number): boolean {
  return ranges.some((r) => r.from < to && from < r.to);
}

// The nearest sibling that is a real block, skipping syntactic *Mark nodes
// (e.g. QuoteMark, which @lezer/markdown interleaves between a blockquote's
// block children). Direction is "prevSibling" | "nextSibling".
function nearestBlockSibling(
  node: SyntaxNode,
  dir: "prevSibling" | "nextSibling"
): SyntaxNode | null {
  let s = node[dir];
  while (s?.name.endsWith("Mark")) {
    s = s[dir];
  }
  return s;
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
  const bulletLists: BulletList[] = [];

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
      if (node.name === "BulletList") {
        if (rangesIntersect(protectedRanges, node.from, node.to)) {
          return true; // still descend for nested lists outside the protected span
        }
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
        // A marker-char change is a CommonMark list boundary: a rewrite is
        // adjacency-safe ONLY when no adjacent BLOCK sibling is another bullet
        // list (else the two lists would merge / flip tight<->loose). Scan past
        // *Mark nodes (QuoteMark inside a blockquote) so "> * a\n> - b" is
        // correctly flagged unsafe. Non-bullet block neighbours (heading/
        // paragraph/ordered list/none) can never merge with a bullet list. This
        // is only the fast filter; per-list + combined structure-oracle gates in
        // bulletUnifyEdits catch thematic-break self-collisions and blind spots.
        const prev = nearestBlockSibling(node.node, "prevSibling");
        const next = nearestBlockSibling(node.node, "nextSibling");
        const adjacencySafe = prev?.name !== "BulletList" && next?.name !== "BulletList";
        if (marks.length > 0) {
          bulletLists.push({ marks, adjacencySafe });
        }
        return true; // descend so nested bullet lists are visited as their own groups
      }
      return undefined;
    },
  });

  return { protectedRanges, tableRanges, orderedLists, bulletLists };
}
