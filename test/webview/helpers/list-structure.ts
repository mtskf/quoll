// Structural assertions for list edits: re-parse the result from scratch and read
// which list item owns a line. Bytes alone cannot show that a bare marker kept its
// body (CommonMark closes a bare item at a blank line right after it).
import type { SyntaxNode } from "@lezer/common";
import { gfmParser } from "../../../src/markdown/gfm-parser.js";

function enclosingItem(node: SyntaxNode | null): SyntaxNode | null {
  let n = node;
  while (n !== null && n.name !== "ListItem") {
    n = n.parent;
  }
  return n;
}

/** The `ListMark` text of the item that holds the item containing `needle`, from
 *  a fresh parse of `doc`; null when that item is top level or `needle` is in no
 *  item at all. */
export function parentMarkOf(doc: string, needle: string): string | null {
  const at = doc.indexOf(needle);
  if (at < 0) {
    throw new Error(`needle not in doc: ${needle}`);
  }
  const own = enclosingItem(gfmParser.parse(doc).resolveInner(at, 1));
  const mark = enclosingItem(own?.parent ?? null)?.getChild("ListMark") ?? null;
  return mark === null ? null : doc.slice(mark.from, mark.to);
}

/** The number of top-level lists in a fresh parse of `doc`. */
export function topLevelListCount(doc: string): number {
  let count = 0;
  for (let n = gfmParser.parse(doc).topNode.firstChild; n !== null; n = n.nextSibling) {
    if (n.name === "BulletList" || n.name === "OrderedList") {
      count++;
    }
  }
  return count;
}
