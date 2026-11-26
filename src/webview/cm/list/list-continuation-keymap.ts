// Enter in a bullet / ordered / task list item continues the list on the next
// line — the Notion/Obsidian "keep the list going" ergonomic. On a NON-EMPTY
// item Enter inserts the next marker (bullet glyph preserved; ordered number
// incremented and delimiter preserved; a task continues as an unchecked `- [ ]`)
// and, for an ordered list, renumbers the following siblings so the run stays
// sequential. On an EMPTY marker line Enter removes the marker, exiting the list;
// a bare marker line that owns a body below (`-\n  text`) continues instead.
//
// PARSE BUDGET: an insert that changes the content column, or that puts a bare
// new marker above a blank line, needs a tree that shows the item closed; without
// one, Enter is consumed and the document is not changed. A bare marker whose
// emptiness cannot be judged is consumed the same way.
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
import { markerLineContent } from "../task-checkbox/task-marker-shape.js";
import { findTaskMarker } from "./list-geometry.js";
import {
  blankGapBetween,
  classifyItemLines,
  contentColumnFromMarkerLine,
  continuationMarkerFor,
  isEmptyItem,
  parseListMark,
  renumberRun,
  shiftOwnLines,
  warnBudgetMiss,
} from "./list-transform.js";
import {
  caretInBlockquote,
  caretInCode,
  listItemAt,
  listMarkOf,
  type SyntaxNode,
} from "./list-tree.js";

/** Resolve the ListItem at `markFrom` from a tree parsed through `upto`. Callers pass
 *  the bound they need: the next line's end to judge a bare marker's emptiness, or
 *  `state.doc.length` to re-resolve for the shift and `renumberRun`, since
 *  `listItemAt`'s caret-line-bounded tree does not contain the siblings below the
 *  caret. Fail-closed: a null `ensureSyntaxTree` means the
 *  parse did not reach `upto` within budget, so the list tail may be unparsed —
 *  returning null here makes the caller skip renumber entirely (the insert still
 *  lands unless it would move the content column; the tail keeps its original
 *  numbers) rather than renumber only the visible prefix (a split-brain run,
 *  worse than none). */
function resolveListItemThrough(
  state: EditorState,
  markFrom: number,
  upto: number
): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, upto, 50);
  if (tree === null) {
    // Dev-only signal (QUOLL_PERF-gated, prod byte-identical): a budget miss on a
    // large doc is a retryable no-op, not "nothing to renumber" — mirrors the same
    // warning on the sibling resolveItemAtEof in list-transform.ts.
    warnBudgetMiss("resolveListItemThrough", state);
    return null;
  }
  let item: SyntaxNode | null = tree.resolveInner(markFrom, 1);
  while (item !== null && item.name !== "ListItem") {
    item = item.parent;
  }
  return item;
}

/** Blank in Lezer's and CommonMark's sense: ASCII spaces and tabs only. */
const ASCII_BLANK = /^[ \t]*$/;

/** The item to judge a bare marker's emptiness on: one whose tree shows the line
 *  below the marker line, which is all `isEmptyItem` needs (a bare item's body
 *  starts there or not at all). On the last line the caret-bounded `item` is
 *  already complete, so no parse is requested. Null = that parse missed its
 *  budget (unknown). */
function bareItemThroughLineBelow(
  state: EditorState,
  item: SyntaxNode,
  markFrom: number,
  lineNo: number
): SyntaxNode | null {
  if (lineNo === state.doc.lines) {
    return item; // no line below: the caret-bounded item is already complete
  }
  return resolveListItemThrough(state, markFrom, state.doc.line(lineNo + 1).to);
}

/** How far past the caret line `closedItemWithin` places its request, in
 *  characters. It bounds the request position, not the tree: after an EOF miss
 *  the returned tree can reach further, holding everything the missed attempt
 *  already parsed. A 10 KB GFM parse took about 1.5 ms in Node (2026-11-26), far
 *  inside the 50 ms budget. */
const CLOSURE_LOOKAHEAD = 10_000;

/** On an EOF budget miss, the ListItem at `markFrom` from a tree requested
 *  through the last complete line end within CLOSURE_LOOKAHEAD of `from` — never
 *  EOF, the parse that just missed — but only when that tree holds a node after
 *  the item or one of its ancestors: the parser has moved past the item, so every
 *  line it owns is there and its shift can be computed. Null otherwise. */
function closedItemWithin(state: EditorState, markFrom: number, from: number): SyntaxNode | null {
  const cap = from + CLOSURE_LOOKAHEAD;
  const last = state.doc.lineAt(Math.min(cap, state.doc.length));
  const upto = last.to <= cap && last.to < state.doc.length ? last.to : last.from - 1;
  if (upto <= from) {
    return null;
  }
  const item = resolveListItemThrough(state, markFrom, upto);
  for (let n = item; n !== null; n = n.parent) {
    if (n.nextSibling !== null) {
      return item;
    }
  }
  return null;
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
  const indent = state.doc.sliceString(caretLine.from, mark.from);
  // Marker-line decision first, on local trees only: a task's emptiness and the
  // caret eligibility below read the caret-bounded `item`, a bare marker's
  // emptiness the line below. Three outcomes: empty → exit; unknown → no edit;
  // otherwise continue. No EOF parse until an edit is known to land.
  const lineContent = markerLineContent(state, mark);
  const judged =
    lineContent === null
      ? bareItemThroughLineBelow(state, item, mark.from, caretLine.number)
      : item;
  if (judged === null) {
    // Emptiness unknown: neither exit (could orphan a body) nor continue (could
    // add a marker under an empty item). Consume Enter, no edit.
    return true;
  }
  const empty = isEmptyItem(state, judged);
  if (empty) {
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
  // A bare marker line that owns a body below continues from the marker end:
  // a caret anywhere in the trailing padding (`-| \n  body`) inserts at the line
  // end, so the body moves under the new item and nothing is deleted. Otherwise
  // continuable content starts after the checkbox for a task, else at the
  // content's start. A caret before it (indent / marker region `1|. a`, or inside
  // `[|x]`) must not split the marker — defer to the default Enter.
  const bare = lineContent === null;
  const taskMarker = lineContent?.name === "Task" ? findTaskMarker(state, lineContent) : null;
  const contentStart = bare ? mark.to : (taskMarker?.to ?? lineContent.from);
  if (head < contentStart) {
    return false;
  }
  const markerStr = continuationMarkerFor(state, item);
  if (markerStr === null) {
    // No representable next marker (the 9-digit ordered cap). A bare marker owns
    // a body here, and upstream Enter would strip the marker and orphan it, so
    // consume Enter without an edit; content-bearing items keep the default Enter.
    return bare;
  }
  const at = bare ? caretLine.to : head;
  // The edit lands, so resolve the item past the caret line — the caret-bounded
  // `item` sees neither its own lines below nor the following siblings. One EOF
  // parse serves shift and renumber; on a miss, a bounded parse that proves the
  // item closed still serves the shift, and the renumber (it needs EOF) is skipped.
  const eofItem = resolveListItemThrough(state, mark.from, state.doc.length);
  const ownItem = eofItem ?? closedItemWithin(state, mark.from, caretLine.to);
  // The tail can add marker padding. Use the complete new line so the item's
  // own lines move to the column where the split content begins.
  const tail = state.doc.sliceString(at, caretLine.to);
  const newContentCol = contentColumnFromMarkerLine(
    indent + markerStr + tail,
    indent.length + markerStr.indexOf(" "),
    state.tabSize
  );
  const oldContentCol = contentColumnFromMarkerLine(
    caretLine.text,
    mark.to - caretLine.from,
    state.tabSize
  );
  // A tail of only ASCII spaces / tabs (not trim(): U+00A0 is content) makes the
  // new line a bare marker, which owns only a block directly below it
  // (`blankGapBetween`): the item's first own line must not sit after a blank line.
  const newBare = ASCII_BLANK.test(tail) && parseListMark(markerStr.trim()) !== null;
  const nextLineBlank =
    caretLine.number < state.doc.lines &&
    ASCII_BLANK.test(state.doc.line(caretLine.number + 1).text);
  if (ownItem === null && (newContentCol !== oldContentCol || (newBare && nextLineBlank))) {
    // The item's lines are unknown and the insert could strand them: the new
    // marker moves the content column (`9.` → `10. `), or a bare new marker would
    // sit above a blank line. Do nothing — but consume Enter, since upstream would
    // strip the marker.
    return true;
  }
  // The new line (marker + tail) goes after any blank lines above the item's first
  // own line, so that line stays directly below it.
  let insertAt = at;
  const firstOwn =
    newBare && ownItem !== null
      ? classifyItemLines(state, ownItem, oldContentCol).ownLines[0]
      : undefined;
  if (firstOwn !== undefined) {
    const gap = blankGapBetween(state, caretLine.number, firstOwn);
    if (gap === null) {
      return true; // text in the gap: nothing safe to move, so no edit
    }
    insertAt = gap.to;
  }
  const insert = `\n${indent}${markerStr}`;
  const moved = insertAt !== at;
  const caret = insertAt - (moved ? tail.length : 0) + insert.length;
  const changes: ChangeSpec[] = moved
    ? [
        { from: at, to: caretLine.to },
        { from: insertAt, insert: insert + tail },
      ]
    : [{ from: at, insert }];
  // All edits below sit past `insertAt`, so the caret is unaffected.
  if (ownItem !== null) {
    changes.push(...shiftOwnLines(state, ownItem, newContentCol));
  }
  if (ordered) {
    // Keep the contiguous ordered run sequential.
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
