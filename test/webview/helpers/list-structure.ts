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

/** The start offsets of every list item that holds offset `pos` in a fresh parse
 *  of `doc`, innermost first (empty outside any list). */
export function itemAncestry(doc: string, pos: number): number[] {
  const out: number[] = [];
  for (let n = enclosingItem(gfmParser.parse(doc).resolveInner(pos, 1)); n !== null; ) {
    out.push(n.from);
    n = enclosingItem(n.parent);
  }
  return out;
}

/** The block holding `needle` in a fresh parse of `doc` (its node name) and the
 *  start of the list item that owns it, or -1 when the block is outside any item. */
export function blockOwner(doc: string, needle: string): [string, number] {
  let n: SyntaxNode | null = gfmParser.parse(doc).resolveInner(doc.indexOf(needle), 1);
  while (
    n !== null &&
    n.parent !== null &&
    n.parent.name !== "ListItem" &&
    n.parent.name !== "Document"
  ) {
    n = n.parent;
  }
  const owner = n?.parent?.name === "ListItem" ? n.parent.from : -1;
  return [n?.name ?? "", owner];
}

/** The number of direct items in each top-level list of a fresh parse of `doc`. */
export function topLevelItemCounts(doc: string): number[] {
  const out: number[] = [];
  for (let n = gfmParser.parse(doc).topNode.firstChild; n !== null; n = n.nextSibling) {
    if (n.name === "BulletList" || n.name === "OrderedList") {
      let items = 0;
      for (let c = n.firstChild; c !== null; c = c.nextSibling) {
        items += c.name === "ListItem" ? 1 : 0;
      }
      out.push(items);
    }
  }
  return out;
}
