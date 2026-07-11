// Enter in a bullet / ordered / task list item continues the list on the next
// line — the Notion/Obsidian "keep the list going" ergonomic. On a NON-EMPTY
// item Enter inserts the next marker (bullet glyph preserved; ordered number
// incremented and delimiter preserved; a task continues as an unchecked `- [ ]`)
// and, for an ordered list, renumbers the following siblings so the run stays
// sequential. On an EMPTY marker line Enter removes the marker, exiting the list.
//
// TRIGGER / DEFER: the command runs on EVERY Enter, so the hot path stays cheap
// (a plain-paragraph caret is rejected after a caret-line-bounded parse). It
// DEFERS (returns false → the default Enter / fencedCodeEnterKeymap runs) for:
//   - read-only, non-empty / multi-range selections;
//   - a caret inside the leading YAML frontmatter (line-native, not a Lezer node —
//     a `  - x` sequence line parses as a BulletList, so guard explicitly);
//   - a non-list caret, or a caret inside a FencedCode / CodeBlock — including a
//     fence opener ON the marker line (`- ```\`, or Blockquote-wrapped `- > ``` `),
//     which fencedCodeEnterKeymap owns (caretInCode resolves AT the caret);
//   - a caret not on the item's marker line (a wrapped / loose body line);
//   - a caret BEFORE the continuable content (the indent / marker / checkbox
//     region, e.g. `1|. a` or `- [|x] a`) — never split the marker.
//
// Every edit is ONE ordinary CM transaction (annotated isolateHistory so a single
// undo reverts the whole continuation / exit / renumber), so it rides the normal
// updateListener → edit-sync → host write-lock pipeline and round-trips
// byte-identically. No raw write path.

import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { type ChangeSpec, EditorSelection, type EditorState, Prec } from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";

import { leadingFrontmatterEnd } from "../frontmatter/detect.js";
import { isContentlessTaskParagraph } from "../task-checkbox/task-marker-shape.js";
import { findTaskMarker } from "./list-geometry.js";
import { caretInCode, listItemAt, listMarkOf, type SyntaxNode } from "./list-tree.js";

/** True when the item has no continuable content: a bare `- ` / `1. `, a
 *  content-less bare task marker (`- [ ]`, which the grammar leaves as a 3-byte
 *  Paragraph), or a `Task` node with only whitespace after its 3-byte
 *  `TaskMarker` (`- [ ] ` / `- [x] ` — the just-typed empty task, which the
 *  grammar emits as a `Task`, not a content-less Paragraph). */
function isEmptyItem(state: EditorState, content: SyntaxNode | null): boolean {
  if (content === null || content.from === content.to) {
    return true;
  }
  if (isContentlessTaskParagraph(state, content)) {
    return true;
  }
  if (content.name === "Task") {
    const marker = findTaskMarker(state, content);
    if (marker !== null && state.doc.sliceString(marker.to, content.to).trim() === "") {
      return true;
    }
  }
  return false;
}

/** Bump every following `ListItem` sibling of the edited item's `OrderedList` by
 *  +1 (they shift down one because a new item was inserted before them). Uses the
 *  Lezer sibling relationship — NOT a line scan — so it is correct across
 *  lazy-continuation lines (inside the item, not siblings), blockquote-prefixed
 *  lists (positions are absolute), and tab-mixed indent. Re-resolves the item
 *  from an EOF-bounded tree because listItemAt's caret-line-bounded tree does not
 *  contain the siblings below the caret. Positions are original-document offsets,
 *  disjoint from the caret insert, so they compose in one ChangeSpec array.
 *
 *  Fail-closed: a null `ensureSyntaxTree` means the parse did not reach EOF within
 *  budget, so the list tail may be unparsed. Renumbering only the visible prefix
 *  would leave a split-brain run (worse than none), so skip renumber entirely —
 *  the insert still lands; the tail keeps its original numbers. */
function orderedRenumberChanges(state: EditorState, markFrom: number): ChangeSpec[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 50);
  if (tree === null) {
    return [];
  }
  let item: SyntaxNode | null = tree.resolveInner(markFrom, 1);
  while (item !== null && item.name !== "ListItem") {
    item = item.parent;
  }
  if (item === null || item.parent?.name !== "OrderedList") {
    return [];
  }
  const changes: ChangeSpec[] = [];
  for (let sib = item.nextSibling; sib !== null; sib = sib.nextSibling) {
    if (sib.name !== "ListItem") {
      continue;
    }
    const sibMark = sib.firstChild;
    if (sibMark === null || sibMark.name !== "ListMark") {
      continue;
    }
    const m = /^(\d+)([.)])$/.exec(state.doc.sliceString(sibMark.from, sibMark.to));
    if (m === null) {
      continue;
    }
    changes.push({
      from: sibMark.from,
      to: sibMark.from + m[1].length,
      insert: String(Number.parseInt(m[1], 10) + 1),
    });
  }
  return changes;
}

export const continueListOnEnter: Command = (view) => {
  const { state } = view;
  if (state.readOnly) {
    return false;
  }
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) {
    return false;
  }
  const head = sel.head;
  // Frontmatter is line-native (not a Lezer node); YAML sequence lines parse as
  // BulletList, so defer explicitly when the caret is inside the leading span.
  if (head <= leadingFrontmatterEnd(state)) {
    return false;
  }
  const caretLine = state.doc.lineAt(head);
  const item = listItemAt(state, head);
  if (item === null) {
    return false;
  }
  const mark = listMarkOf(item);
  if (mark === null) {
    return false;
  }
  // Only continue from the item's MARKER line; a caret on a wrapped / loose body
  // line falls through to the default Enter.
  if (state.doc.lineAt(mark.from).number !== caretLine.number) {
    return false;
  }
  // A fence opener ON the marker line (`- ```\`, or wrapped `- > ``` `) resolves
  // to the ListItem via the marker probe; fencedCodeEnterKeymap owns it. Resolve
  // AT the caret (catches the blockquote-wrapped case a content-name check misses).
  if (caretInCode(state, head)) {
    return false;
  }
  const ordered = item.parent?.name === "OrderedList";
  const bullet = item.parent?.name === "BulletList";
  if (!ordered && !bullet) {
    return false;
  }
  const content = mark.nextSibling;
  const indent = state.doc.sliceString(caretLine.from, mark.from);
  if (isEmptyItem(state, content)) {
    return false; // empty-exit handled in a later slice
  }
  // content is non-null here (isEmptyItem covers the null case).
  const contentNode = content as SyntaxNode;
  const isTask = contentNode.name === "Task";
  // Continuable content starts after the checkbox for a task, else at content.from.
  // A caret before it (indent / marker region `1|. a`, or inside `[|x]`) must not
  // split the marker — defer to the default Enter.
  const taskMarker = isTask ? findTaskMarker(state, contentNode) : null;
  const contentStart = taskMarker !== null ? taskMarker.to : contentNode.from;
  if (head < contentStart) {
    return false;
  }
  let base: string;
  if (bullet) {
    base = state.doc.sliceString(mark.from, mark.to);
  } else {
    const m = /^(\d+)([.)])$/.exec(state.doc.sliceString(mark.from, mark.to));
    if (m === null) {
      return false;
    }
    const n = Number.parseInt(m[1], 10);
    if (!Number.isFinite(n)) {
      return false;
    }
    base = `${n + 1}${m[2]}`;
  }
  const markerStr = isTask ? `${base} [ ] ` : `${base} `;
  const insert = `\n${indent}${markerStr}`;
  const caret = head + insert.length;
  const changes: ChangeSpec[] = [{ from: head, insert }];
  if (ordered) {
    // Keep the contiguous ordered run sequential; caret is unaffected because the
    // renumber edits sit past `head`.
    changes.push(...orderedRenumberChanges(state, mark.from));
  }
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(caret),
    userEvent: "input",
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
  return true;
};

/** Keymap: Enter → continue / exit a list item. Prec.high so it precedes the
 *  default Enter and the fenced-code Enter; returns false for every non-list
 *  caret so those still run. */
export function listContinuationKeymap() {
  return Prec.high(keymap.of([{ key: "Enter", run: continueListOnEnter }]));
}
