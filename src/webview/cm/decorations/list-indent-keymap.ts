// Tab / Shift-Tab list-item indent (nest) / outdent (promote).
//
// When the caret sits inside a bullet / ordered / task list item, Tab nests the
// item under its preceding sibling and Shift-Tab promotes it to its parent's
// level — Notion/Obsidian structural nesting. The depth is MARKER-driven
// (CommonMark): a child's marker must reach the preceding sibling's content
// column, so a bullet nests by 2 (`- `) and an ordered item by 3 (`1. `). This
// is not a free indent unit — a fixed "2 spaces" would leave ordered lists
// un-nested (`1. A` + 2-space `2. B` parses as a SIBLING, not a child). The
// command edits RAW Markdown source (leading whitespace only), dispatched
// through `view.dispatch`, so the change rides the normal updateListener →
// edit-sync → host write-lock pipeline and round-trips byte-identically. A
// uniform subtree shift preserves the item's own children's relative nesting.
//
// Return-value contract (this boolean is the CM `Command` "handled?" convention):
//   - read-only doc → false (view mode → normal focus nav; nothing to indent);
//   - EVERYTHING ELSE → true. In a list item we nest/promote (or a structural
//     no-op: first item has no preceding sibling; top-level item has no parent).
//     Outside a list, or inside FencedCode/CodeBlock, it is a no-op that STILL
//     returns true — swallowing Tab so it never escapes to VS Code focus
//     navigation (the user's original bug). a11y (intentional, matches
//     Notion/Obsidian): Tab is captured in the editable editor; keyboard focus
//     leaves via VS Code's F6 / Focus-Next-Part or the mouse, not Tab.
//
// Resolution probes the caret LINE's first non-whitespace column (not the raw
// caret head): a caret at end-of-line resolves side-forward to the enclosing
// list container, and a caret on the leading spaces before a fenced-code fence
// would resolve to the wrapping ListItem (leading indent is not part of the
// FencedCode node). The first non-whitespace char is squarely inside the line's
// innermost construct. The tree comes from ensureSyntaxTree so a freshly-seeded
// long doc whose caret region is not yet lazily parsed still classifies.
//
// Self-contained: does NOT import list-geometry.ts (its helpers carry task-fold
// fail-closed semantics irrelevant here).

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type ChangeSpec, countColumn, type EditorState, Prec } from "@codemirror/state";
import { type Command, type EditorView, keymap } from "@codemirror/view";

// Derive SyntaxNode from syntaxTree's return type (same strategy as
// list-geometry.ts — @lezer/common is transitive-only, not hoisted).
type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

/** Visual column of `pos` within its own line (tabs expanded to tabSize). */
function columnAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return countColumn(line.text, state.tabSize, pos - line.from);
}

/** The innermost `ListItem` for the line containing `head`, or null when that
 *  line is not in a list item OR the probe sits inside a `FencedCode` /
 *  `CodeBlock`. Probes the line's first non-whitespace column, not `head`. */
function listItemAt(state: EditorState, head: number): SyntaxNode | null {
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
function listMarkOf(item: SyntaxNode): SyntaxNode | null {
  const first = item.firstChild;
  return first !== null && first.name === "ListMark" ? first : null;
}

/** Column where the item's content begins (its ListMark's next sibling), or
 *  null when the item is empty / malformed. This is the nesting target column:
 *  a child indented to here parses as nested under the item. */
function contentColumnOf(state: EditorState, item: SyntaxNode): number | null {
  const mark = listMarkOf(item);
  if (mark === null) {
    return null;
  }
  const content = mark.nextSibling;
  if (content === null || content.from === content.to) {
    return null;
  }
  return columnAt(state, content.from);
}

/** The `ListItem` that encloses `item`'s list (shape: ListItem > list > ListItem),
 *  or null when `item` is top-level. */
function enclosingListItem(item: SyntaxNode): SyntaxNode | null {
  const parent = item.parent?.parent ?? null;
  return parent !== null && parent.name === "ListItem" ? parent : null;
}

/** The `ListItem` immediately preceding `item` within the same list, or null
 *  when `item` is the first in its list. */
function precedingListItem(item: SyntaxNode): SyntaxNode | null {
  const prev = item.prevSibling;
  return prev !== null && prev.name === "ListItem" ? prev : null;
}

/** First / last 1-based line numbers of the item's subtree. `item.to - 1` is
 *  the last byte inside the item (item.to can land on the next line's start). */
function itemLineRange(state: EditorState, item: SyntaxNode): { first: number; last: number } {
  return {
    first: state.doc.lineAt(item.from).number,
    last: state.doc.lineAt(Math.max(item.from, item.to - 1)).number,
  };
}

/** Number of leading-whitespace CHARS whose expanded columns reach `cols` (a
 *  straddling tab is counted whole → slight over-de-dent, documented). Stops at
 *  the first non-whitespace char. */
function leadingCharsForColumns(text: string, cols: number, tabSize: number): number {
  let col = 0;
  let i = 0;
  while (i < text.length && col < cols) {
    const ch = text.charCodeAt(i);
    if (ch === 0x20) {
      col += 1;
    } else if (ch === 0x09) {
      col += tabSize - (col % tabSize);
    } else {
      break;
    }
    i++;
  }
  return i;
}

/** Build the change set that shifts every NON-BLANK line of `item`'s subtree by
 *  `deltaCols` columns (> 0 prepends spaces; < 0 removes up to |deltaCols|
 *  leading-whitespace columns). Blank / whitespace-only lines are skipped.
 *  Returns [] when there is nothing to change. */
function shiftItemLines(state: EditorState, item: SyntaxNode, deltaCols: number): ChangeSpec[] {
  if (deltaCols === 0) {
    return [];
  }
  const { first, last } = itemLineRange(state, item);
  const changes: ChangeSpec[] = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (line.text.trim() === "") {
      continue; // skip blank / whitespace-only lines (no trailing-space noise)
    }
    if (deltaCols > 0) {
      changes.push({ from: line.from, insert: " ".repeat(deltaCols) });
    } else {
      const remove = leadingCharsForColumns(line.text, -deltaCols, state.tabSize);
      if (remove > 0) {
        changes.push({ from: line.from, to: line.from + remove });
      }
    }
  }
  return changes;
}

/** Dispatch the shift as ONE transaction; ALWAYS returns true (empty changes =
 *  intentional no-op; a dead-view throw still means "we owned this Tab" — never
 *  fall through to CM's default Tab / escape focus). */
function applyShift(
  view: EditorView,
  changes: ChangeSpec[],
  userEvent: "input.indent" | "delete.dedent"
): boolean {
  if (changes.length === 0) {
    return true;
  }
  try {
    view.dispatch({ changes, userEvent });
  } catch (err) {
    console.error("[quoll] list indent dispatch failed", err);
  }
  return true;
}

/** Tab: nest the item at the caret under its preceding sibling. */
export const indentListItem: Command = (view) => {
  const { state } = view;
  if (state.readOnly) {
    return false;
  }
  const item = listItemAt(state, state.selection.main.head);
  if (item === null) {
    return true; // outside a list (incl. code) → swallow, no focus escape
  }
  const mark = listMarkOf(item);
  if (mark === null) {
    return true;
  }
  const prev = precedingListItem(item);
  if (prev === null) {
    return true; // first item — nothing to nest under
  }
  const targetCol = contentColumnOf(state, prev);
  if (targetCol === null) {
    return true;
  }
  const delta = targetCol - columnAt(state, mark.from);
  if (delta <= 0) {
    return true; // pathological alignment — no-op
  }
  return applyShift(view, shiftItemLines(state, item, delta), "input.indent");
};

/** Shift-Tab: promote the item at the caret to its parent's level. */
export const outdentListItem: Command = (view) => {
  const { state } = view;
  if (state.readOnly) {
    return false;
  }
  const item = listItemAt(state, state.selection.main.head);
  if (item === null) {
    return true;
  }
  const mark = listMarkOf(item);
  if (mark === null) {
    return true;
  }
  const parent = enclosingListItem(item);
  if (parent === null) {
    return true; // top-level — nothing to promote to
  }
  const parentMark = listMarkOf(parent);
  if (parentMark === null) {
    return true;
  }
  const delta = columnAt(state, parentMark.from) - columnAt(state, mark.from);
  if (delta >= 0) {
    return true;
  }
  return applyShift(view, shiftItemLines(state, item, delta), "delete.dedent");
};

/** Keymap: Tab → indent, Shift-Tab → outdent. Prec.high so Tab is intercepted
 *  before CodeMirror's default (which would move focus out of the editor). */
export function listIndentKeymap() {
  return Prec.high(
    keymap.of([
      { key: "Tab", run: indentListItem },
      { key: "Shift-Tab", run: outdentListItem },
    ])
  );
}
