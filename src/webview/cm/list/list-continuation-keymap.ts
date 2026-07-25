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
//   - a blockquote nested in the item (`- > quote`), which the upstream
//     markdownKeymap handler owns — it preserves the `>` context (caretInBlockquote
//     resolves AT the caret). Deferring keeps the Prec.highest promotion from
//     stealing blockquote Enter (see the factory note; a list nested in a quote
//     `> - x` already defers earlier via listItemAt's `>`-column probe);
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
import { findTaskMarker } from "./list-geometry.js";
import {
  continuationMarkerFor,
  isEmptyItem,
  parseListMark,
  renumberRun,
  warnBudgetMiss,
} from "./list-transform.js";
import {
  caretInBlockquote,
  caretInCode,
  listItemAt,
  listMarkOf,
  type SyntaxNode,
} from "./list-tree.js";

/** Re-resolve `item` from an EOF-bounded tree: `listItemAt`'s caret-line-bounded
 *  tree does not contain the siblings below the caret, which `renumberRun`
 *  needs to walk. Fail-closed: a null `ensureSyntaxTree` means the parse did
 *  not reach EOF within budget, so the list tail may be unparsed — returning
 *  null here makes the caller skip renumber entirely (the insert still lands;
 *  the tail keeps its original numbers) rather than renumber only the visible
 *  prefix (a split-brain run, worse than none). */
function resolveAtEof(state: EditorState, markFrom: number): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, state.doc.length, 50);
  if (tree === null) {
    // Dev-only signal (QUOLL_PERF-gated, prod byte-identical): a budget miss on a
    // large doc is a retryable no-op, not "nothing to renumber" — mirrors the same
    // warning on the sibling resolveItemAtEof in list-transform.ts.
    warnBudgetMiss("resolveAtEof", state);
    return null;
  }
  let item: SyntaxNode | null = tree.resolveInner(markFrom, 1);
  while (item !== null && item.name !== "ListItem") {
    item = item.parent;
  }
  return item;
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
  // A blockquote nested in THIS item (`- > quote`) is the upstream markup handler's
  // domain — defer so it continues the quote (`- > q\n  > `) instead of Quoll
  // splitting into a sibling list marker (`- > q\n- `, dropping the quote). This is
  // the case the Prec.highest promotion would otherwise steal (regression caught in
  // review). The opposite nesting (a list INSIDE a blockquote, `> - x`) already
  // defers earlier: listItemAt's marker-column probe lands on the `>` QuoteMark and
  // returns null. This guard covers it too as belt-and-suspenders, keeping upstream
  // the sole owner of all blockquote continuation per the documented fallback contract.
  if (caretInBlockquote(state, head)) {
    return false;
  }
  const ordered = item.parent?.name === "OrderedList";
  const bullet = item.parent?.name === "BulletList";
  if (!ordered && !bullet) {
    return false;
  }
  const content = mark.nextSibling;
  const indent = state.doc.sliceString(caretLine.from, mark.from);
  if (isEmptyItem(state, item)) {
    // Empty item → remove the whole marker line, exiting the list. Uniform across
    // nesting: no outdent (outdentListItem shifts whitespace only and would leave
    // a duplicate ordered number at the promoted level — Codex review 2026-07-11).
    view.dispatch({
      changes: { from: caretLine.from, to: caretLine.to },
      selection: EditorSelection.cursor(caretLine.from),
      userEvent: "delete",
      annotations: isolateHistory.of("full"),
    });
    return true;
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
  const markerStr = continuationMarkerFor(state, item);
  if (markerStr === null) {
    return false;
  }
  const insert = `\n${indent}${markerStr}`;
  const caret = head + insert.length;
  const changes: ChangeSpec[] = [{ from: head, insert }];
  if (ordered) {
    // Keep the contiguous ordered run sequential; caret is unaffected because the
    // renumber edits sit past `head`. Re-resolve from an EOF-bounded tree (the
    // caret-bounded `item` above does not see siblings past the caret).
    const eofItem = resolveAtEof(state, mark.from);
    const precedingShape = parseListMark(state.doc.sliceString(mark.from, mark.to));
    if (eofItem !== null && precedingShape !== null && precedingShape.kind === "ordered") {
      // The inserted item's own number is precedingNumber + 1 (continuationMarkerFor's
      // ordered branch); the first following sibling continues one past that.
      const editedNumber = precedingShape.number + 1;
      changes.push(...renumberRun(state, eofItem, editedNumber + 1));
    }
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

/** Keymap: Enter → continue / exit a list item. `Prec.highest` so it wins over
 *  the upstream `markdownKeymap` Enter (`insertNewlineContinueMarkup`, mounted at
 *  `Prec.high` by quollMarkdownLanguage). Equal-precedence keymaps resolve in
 *  registration order and the language mounts FIRST, so at a matching `Prec.high`
 *  upstream shadowed this handler in list contexts — it returns true for
 *  bullet/ordered items, so Quoll's marker/renumber/exit semantics never ran
 *  (visible for non-sequential ordered runs, whose renumber upstream omits).
 *  Raising to `Prec.highest` makes Quoll own PLAIN list-item Enter, but the
 *  command still DEFERS (returns false) for blockquote-involved carets so upstream
 *  keeps all blockquote continuation, and for a fence opener on a marker line so
 *  fencedCodeEnterKeymap (also `Prec.highest`, registered after) wins — upstream is
 *  the blockquote / Backspace `deleteMarkupBackward` fallback. Pinned by
 *  cm-enter-precedence.test.ts. */
export function listContinuationKeymap() {
  return Prec.highest(keymap.of([{ key: "Enter", run: continueListOnEnter }]));
}
