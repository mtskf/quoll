// Shared list-tree resolution — the SINGLE definition of "the list item at this
// caret" for the list keymaps (Tab/Shift-Tab indent + Enter continuation). Both
// keymaps must classify a caret identically (a divergence would let one act on a
// line the other treats as non-list), so the resolver lives here rather than in
// either keymap. A zero-side-effect leaf: it imports only CodeMirror
// language/state utilities and derives its node type from syntaxTree's return.

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

// Derive SyntaxNode from syntaxTree's return type (same strategy as
// list-geometry.ts — @lezer/common is a direct dep as of PR #66, derived rather
// than imported to keep the direct-dep surface narrow).
export type Tree = ReturnType<typeof syntaxTree>;
export type SyntaxNode = Tree["topNode"];

/** The innermost `ListItem` for the line containing `head`, or null when that
 *  line is not in a list item OR the probe sits inside a `FencedCode` /
 *  `CodeBlock`. Probes the line's first non-whitespace column, not `head`. */
export function listItemAt(state: EditorState, head: number): SyntaxNode | null {
  const line = state.doc.lineAt(head);
  const blank = line.text.trim() === "";
  const wsLen = line.text.length - line.text.trimStart().length;
  // Blank line: probe at line.from. If that position is structurally inside a
  // ListItem (a loose item's blank interior line), the item is still returned;
  // otherwise the walk-up reaches Document and returns null.
  const probe = blank ? line.from : line.from + wsLen;
  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  let node: SyntaxNode | null = tree.resolveInner(probe, 1);
  while (node !== null) {
    if (node.name === "FencedCode" || node.name === "CodeBlock") {
      return null;
    }
    if (node.name === "ListItem") {
      return node;
    }
    node = node.parent;
  }
  return null;
}

/** The item's `ListMark` child, or null on grammar drift. */
export function listMarkOf(item: SyntaxNode): SyntaxNode | null {
  const first = item.firstChild;
  return first !== null && first.name === "ListMark" ? first : null;
}

/** True for the two list container node types — `OrderedList` / `BulletList`. */
export function isListNode(node: SyntaxNode): boolean {
  return node.name === "OrderedList" || node.name === "BulletList";
}

/** The `ListItem` that encloses `item`'s list (shape: ListItem > list >
 *  ListItem), or null when `item` is top-level. Requires the wrapper parent to
 *  carry a `ListMark` so the walk-up only climbs well-formed nesting — the
 *  shared definition; `list-geometry.ts` still keeps its own private copy (not
 *  yet rerouted here). */
export function enclosingListItem(item: SyntaxNode): SyntaxNode | null {
  const parent = item.parent?.parent ?? null;
  if (parent === null || parent.name !== "ListItem") {
    return null;
  }
  return listMarkOf(parent) !== null ? parent : null;
}

/** The last `ListItem` sibling within `listNode` (an `OrderedList` /
 *  `BulletList`), or null when the list has no ListItem children. */
export function lastListItemOf(listNode: SyntaxNode): SyntaxNode | null {
  let last: SyntaxNode | null = null;
  for (let n = listNode.firstChild; n !== null; n = n.nextSibling) {
    if (n.name === "ListItem") {
      last = n;
    }
  }
  return last;
}

/** The `ListItem` siblings following `item` within the same list, in document
 *  order (a Lezer-sibling walk, not a line scan). */
export function followingListItems(item: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let n = item.nextSibling; n !== null; n = n.nextSibling) {
    if (n.name === "ListItem") {
      out.push(n);
    }
  }
  return out;
}

/** The item `item` should nest under when indenting: its preceding sibling
 *  `ListItem` when one exists; otherwise, when `item` is the first item of its
 *  list AND the list's own preceding sibling is another list node (adjacent
 *  lists — e.g. an ordered list immediately followed by a bullet list), the
 *  last `ListItem` of that preceding list (cross-list resolution). Null when
 *  neither resolves (item is the doc's first list item). */
export function destinationForIndent(item: SyntaxNode): SyntaxNode | null {
  const prev = item.prevSibling;
  if (prev !== null && prev.name === "ListItem") {
    return prev;
  }
  const list = item.parent;
  const prevList = list?.prevSibling ?? null;
  if (prevList !== null && isListNode(prevList)) {
    return lastListItemOf(prevList);
  }
  return null;
}

/** The item `item` should promote to when outdenting: the enclosing parent
 *  item whose run it joins. Alias of `enclosingListItem` kept as a distinct
 *  name so callers express intent (indent destination vs. outdent
 *  destination) rather than the raw tree-shape query. */
export function destinationForOutdent(item: SyntaxNode): SyntaxNode | null {
  return enclosingListItem(item);
}

/** True when `pos` sits inside a `FencedCode` / `CodeBlock`. Resolves AT the
 *  caret (biased left so a caret at the end of a fence-opener line resolves into
 *  the fence) and walks ancestors — so a fence that begins on a list item's
 *  marker line, including a Blockquote-wrapped fence (`- > ``` `), is detected
 *  even though `listItemAt` (which probes the marker column) still returns the
 *  ListItem. Bounds the parse to the caret line / `pos` (a fence opener forces
 *  the forward extent scan the same way fenced-code-enter-keymap relies on). */
export function caretInCode(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state, Math.max(line.to, pos), 50) ?? syntaxTree(state);
  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n !== null; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") {
      return true;
    }
  }
  return false;
}
