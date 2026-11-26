/**
 * Pure structural-transform primitives for list markers.
 *
 * This module provides the foundational marker-parsing and marker-formatting utilities:
 * `parseListMark` (recognizes CommonMark list markers and normalizes them into structured
 * form) and `formatMarker` (emits a marker string from that form).
 *
 * Why marker-KIND adoption matters: CommonMark specifies that within a single list,
 * all items MUST use the same marker kind (all bullet, or all ordered with the same delimiter).
 * A marker-semantic layer (this module) abstracts away glyph variability so that higher-level
 * list operations (planner, renumber) can reason about list homogeneity without re-parsing.
 *
 * Also provides `classifyItemLines`: pure line-classification for a `ListItem`'s
 * subtree, splitting the marker line from the item's OWN body/descendant lines
 * while EXCLUDING lazy-continuation lines. CommonMark lets a paragraph continue
 * a list item purely by NOT being blank and NOT starting a new block ("laziness"),
 * even when its indentation doesn't reach the item's content column (e.g. a
 * malformed 2-space-indented nested item swallowing subsequent flush-left
 * paragraphs). A later subtree-shift planner must move only the item's
 * STRUCTURALLY-owned lines — shifting a lazy line along with the item would
 * incorrectly relocate text that (by CommonMark's own rules) doesn't
 * structurally belong to it.
 *
 * Built on these primitives, this module also owns the list-structure
 * transforms themselves: `renumberRun` (width-aware run resequencing) and the
 * Tab/Shift-Tab planners `planIndentItem` / `planOutdentItem` (content-column
 * nesting, marker adoption, forced-child re-homing), each returning a
 * `ListEditPlan` the `list-indent-keymap.ts` shell dispatches.
 *
 * TODO (follow-up, out of scope here to keep 1PR=1purpose): this file has grown
 * past the 500-line guideline — the planners + their private helpers
 * (`resolveItemAtEof`, the adopt/shape builders) form a distinct concern from
 * the marker primitives / classification and could move to a
 * `list-indent-plan.ts`, leaving the primitives here.
 */

import { ensureSyntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  countColumn,
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
} from "@codemirror/state";

import {
  isContentlessTaskParagraph,
  markerLineContent,
} from "../task-checkbox/task-marker-shape.js";
import { columnAt, findTaskMarker, isTaskItem } from "./list-geometry.js";
import {
  caretInCode,
  destinationForIndent,
  destinationForOutdent,
  followingListItems,
  indentLength,
  isListNode,
  lastListItemOf,
  listMarkOf,
  type SyntaxNode,
} from "./list-tree.js";

export type ListMarkShape =
  | { kind: "bullet"; glyph: "-" | "*" | "+" }
  | { kind: "ordered"; number: number; delim: "." | ")" };

const ORDERED_RE = /^(\d{1,9})([.)])$/; // Lezer caps ordered ListMark at 9 digits

export const MAX_LIST_NUMBER = 999_999_999; // @lezer/markdown caps a ListMark at 9 digits

/** Build an ordered shape, or null when `number` is out of the 0..MAX range
 *  (the sole cap-enforcement point — callers propagate null as a fail-closed
 *  no-op instead of re-checking the literal). Guards BOTH bounds: `< 0` (a
 *  renumber delta can drive a follower NEGATIVE, which `ORDERED_RE` rejects =
 *  corrupt Markdown; note `0.` itself is a VALID CommonMark ordered start, so
 *  the reject condition is strictly negative, not `< 1`) and `> MAX` (a
 *  10+-digit run stops being a ListMark). */
export function orderedShape(number: number, delim: "." | ")"): ListMarkShape | null {
  return number >= 0 && number <= MAX_LIST_NUMBER ? { kind: "ordered", number, delim } : null;
}

export function parseListMark(text: string): ListMarkShape | null {
  if (text === "-" || text === "*" || text === "+") {
    return { kind: "bullet", glyph: text };
  }
  const m = ORDERED_RE.exec(text);
  if (m === null) {
    return null;
  }
  const number = Number.parseInt(m[1], 10);
  return { kind: "ordered", number, delim: m[2] as "." | ")" };
}

export function formatMarker(shape: ListMarkShape): string {
  return shape.kind === "bullet" ? shape.glyph : `${shape.number}${shape.delim}`;
}

/** Column where the item's content begins (its `markerLineContent`), with a
 *  fallback for an empty/malformed item — including one whose content starts on
 *  a later line — so it is NEVER null: `markCol +
 *  markerLen + 1` (the CommonMark implied single-space content indent — the
 *  same convention `list-geometry.ts`'s `ownMarkerWidth` uses for an empty
 *  item's hang). */
export function contentColumnOf(state: EditorState, item: SyntaxNode): number {
  const mark = listMarkOf(item);
  if (mark === null) {
    return columnAt(state, item.from);
  }
  const markCol = columnAt(state, mark.from);
  const content = markerLineContent(state, mark);
  if (content === null) {
    return markCol + (mark.to - mark.from) + 1;
  }
  return columnAt(state, content.from);
}

/** CommonMark content column for a marker line. Empty items and items starting
 *  with indented code use one column of marker padding. */
export function contentColumnFromMarkerLine(
  text: string,
  markerEnd: number,
  tabSize: number
): number {
  const markerEndCol = countColumn(text, tabSize, markerEnd);
  let i = markerEnd;
  while (text[i] === " " || text[i] === "\t") {
    i++;
  }
  if (i === text.length) {
    return markerEndCol + 1;
  }
  const col = countColumn(text, tabSize, i);
  return col - markerEndCol > 4 ? markerEndCol + 1 : col;
}

/** First non-whitespace column of `line`, or `null` when the line is blank /
 *  only ASCII spaces / tabs (`indentLength`: a U+00A0 line is text). */
function firstNonWsColumn(state: EditorState, lineNumber: number): number | null {
  const line = state.doc.line(lineNumber);
  const wsLen = indentLength(line.text);
  if (wsLen === line.text.length) {
    return null;
  }
  return columnAt(state, line.from + wsLen);
}

/** Classifies every line of `item`'s subtree into the marker line and the
 *  item's own body/descendant lines, EXCLUDING lazy-continuation lines.
 *
 *  `markerLine` is the item's first line (where its `ListMark` sits) — kept
 *  separate from `ownLines` so a caller can shift the marker line and the body
 *  lines by different deltas (e.g. a marker-width change only affects the
 *  marker line).
 *
 *  `ownLines` are the remaining (non-blank) lines of the subtree whose first
 *  non-whitespace column is >= `contentCol`, which defaults to the tree-based
 *  content column. Pass the shift boundary when moving lines so classification
 *  uses the same column as the shift. A line under that column is only part of
 *  the item by CommonMark laziness (e.g. a flush-left paragraph continuing a
 *  loosely-indented nested item) and is excluded — moving the item must not
 *  drag lazy text that isn't structurally the item's.
 *
 *  Note the marker line itself sits at the MARKER column (< content column by
 *  construction — e.g. `  - ddd` marker col 2 < content col 4), so it is
 *  bucketed by position (line 1) rather than by the column test — a naive
 *  "col >= content" test would wrongly exclude it from the item's own lines.
 *
 *  A bare marker that owns no body (`bareMarkerOwnsBody`) has no own lines even
 *  when Lezer spans it over a blank line and the text after it: that text
 *  belongs to the enclosing block (CommonMark), so moving the item must not
 *  drag it. */
export function classifyItemLines(
  state: EditorState,
  item: SyntaxNode,
  contentCol = contentColumnOf(state, item)
): { markerLine: number; ownLines: number[] } {
  const first = state.doc.lineAt(item.from).number;
  const last = state.doc.lineAt(Math.max(item.from, item.to - 1)).number;
  const markerLine = first;
  const ownLines: number[] = [];
  const mark = listMarkOf(item);
  if (mark !== null && isBodilessBareMarker(state, mark)) {
    return { markerLine, ownLines };
  }
  for (let n = first + 1; n <= last; n++) {
    const col = firstNonWsColumn(state, n);
    if (col !== null && col >= contentCol) {
      ownLines.push(n);
    }
  }
  return { markerLine, ownLines };
}

/** A whitespace edit on one line: `text.slice(from, to)` becomes `insert`. */
type PrefixShift = { from: number; to: number; insert: string };

/** Move the column `boundary` of `line` by `delta` by rewriting only the
 *  whitespace before it: chars wholly left of the new position are kept, the
 *  rest up to the boundary becomes spaces. A tab straddling either column is
 *  split into spaces rather than dropped whole, and a space added before a tab
 *  is not absorbed by its tab stop. Null when a non-whitespace char sits before
 *  the boundary (a lazy line — not this item's to move). `col` is the column
 *  the walk stopped at (past `boundary` when a tab straddles it). */
function shiftPrefix(
  line: Line,
  boundary: number,
  delta: number,
  tabSize: number
): (PrefixShift & { col: number }) | null {
  const keepThrough = Math.min(boundary, boundary + delta);
  let i = 0;
  let col = 0;
  let keep = 0;
  let keptCol = 0;
  while (col < boundary) {
    const ch = line.text[i];
    if (ch === " ") {
      col++;
    } else if (ch === "\t") {
      col += tabSize - (col % tabSize);
    } else {
      return null;
    }
    i++;
    if (col <= keepThrough) {
      keep = i;
      keptCol = col;
    }
  }
  return {
    from: line.from + keep,
    to: line.from + i,
    insert: " ".repeat(col + delta - keptCol),
    col,
  };
}

/** Move the marker of `mark`'s line by `delta` columns (the whitespace before
 *  it only — the marker itself is rewritten by a separate, adjacent change). */
function shiftMarkerLine(state: EditorState, mark: SyntaxNode, delta: number): PrefixShift | null {
  if (delta === 0) {
    return null;
  }
  const shift = shiftPrefix(
    state.doc.lineAt(mark.from),
    columnAt(state, mark.from),
    delta,
    state.tabSize
  );
  return shift === null ? null : { from: shift.from, to: shift.to, insert: shift.insert };
}

/** True when `col` still lies within the indentation a fenced block's code line
 *  gives up to the opening fence (CommonMark strips up to that many columns), so
 *  a whitespace char there is container padding to move, not code content.
 *  Inside a blockquote the fence and code lines can put their `>` at different
 *  columns, so absolute columns say nothing: keep the bytes (never in the indent). */
function inFenceIndent(state: EditorState, codeText: SyntaxNode, col: number): boolean {
  const fence = codeText.parent;
  if (fence?.name !== "FencedCode") {
    return false;
  }
  const line = state.doc.lineAt(codeText.from);
  return (
    !line.text.slice(0, codeText.from - line.from).includes(">") &&
    col < columnAt(state, fence.from)
  );
}

/** Expand tabs whose width changes across nested list and quote prefixes to preserve indentation.
 *  HTML continuation payload starts at its owning item's content column. Preserve CodeText
 *  (past the fence's own indentation) and any quote-padding tab immediately
 *  before it. */
function shiftLine(
  state: EditorState,
  item: SyntaxNode,
  lineNumber: number,
  boundary: number,
  delta: number
): ChangeSpec | null {
  const line = state.doc.line(lineNumber);
  const prefix = shiftPrefix(line, boundary, delta, state.tabSize);
  if (prefix === null) {
    return null;
  }
  const keep = prefix.from - line.from;
  let i = prefix.to - line.from;
  let col = prefix.col;
  let insert = prefix.insert;
  const block = item.resolve(line.from, 1);
  let payloadCol = Infinity;
  if (
    block.from < line.from &&
    (block.name === "HTMLBlock" ||
      block.name === "CommentBlock" ||
      block.name === "ProcessingInstructionBlock")
  ) {
    let owner = block.parent;
    while (owner && owner.name !== "ListItem") {
      owner = owner.parent;
    }
    const mark = owner && listMarkOf(owner);
    payloadCol = boundary;
    if (mark) {
      const markerLine = state.doc.lineAt(mark.from);
      payloadCol = contentColumnFromMarkerLine(
        markerLine.text,
        mark.to - markerLine.from,
        state.tabSize
      );
    }
  }
  while (i < line.length && col < payloadCol) {
    const pos = line.from + i;
    const node = item.resolve(pos, 1);
    if (
      (node.name === "CodeText" && !inFenceIndent(state, node, col)) ||
      (line.text[i] === "\t" &&
        item.resolve(pos, -1).name === "QuoteMark" &&
        item.resolve(pos + 1, 1).name === "CodeText")
    ) {
      break;
    }

    const ch = line.text[i];
    if (ch === "\t") {
      const width = state.tabSize - (col % state.tabSize);
      const shiftedWidth = state.tabSize - ((col + delta) % state.tabSize);
      insert += width === shiftedWidth ? ch : " ".repeat(width);
      col += width;
    } else if (ch === " ") {
      insert += ch;
      col++;
    } else if (node.from === pos && (node.name === "ListMark" || node.name === "QuoteMark")) {
      insert += line.text.slice(i, node.to - line.from);
      col += node.to - pos;
      i = node.to - line.from;
      continue;
    } else {
      break;
    }
    i++;
  }
  return line.text.slice(keep, i) === insert
    ? null
    : { from: line.from + keep, to: line.from + i, insert };
}

/** Move the item's own lines using CommonMark marker padding on both sides
 *  of a split or renumber so nested content keeps its relative indentation. */
export function shiftOwnLines(
  state: EditorState,
  item: SyntaxNode,
  newContentCol: number
): ChangeSpec[] {
  const mark = listMarkOf(item);
  if (mark === null) {
    return [];
  }
  const markerLine = state.doc.lineAt(mark.from);
  const boundary = contentColumnFromMarkerLine(
    markerLine.text,
    mark.to - markerLine.from,
    state.tabSize
  );
  const delta = newContentCol - boundary;
  if (delta === 0) {
    return [];
  }
  const changes: ChangeSpec[] = [];
  for (const lineNo of classifyItemLines(state, item, boundary).ownLines) {
    const change = shiftLine(state, item, lineNo, boundary, delta);
    if (change !== null) {
      changes.push(change);
    }
  }
  return changes;
}

/** The content column `mark`'s item has once its marker sits at `newMarkCol` as
 *  `newMarker`, read off the rewritten marker line (not derived from marker
 *  movement: a tab after the marker re-stops at the new column, so the content
 *  column does not move by the marker delta + width delta). */
function contentColumnAfterMove(
  state: EditorState,
  mark: SyntaxNode,
  newMarkCol: number,
  newMarker: string
): number {
  const line = state.doc.lineAt(mark.from);
  const text = " ".repeat(newMarkCol) + newMarker + line.text.slice(mark.to - line.from);
  return contentColumnFromMarkerLine(text, newMarkCol + newMarker.length, state.tabSize);
}

/** Whether the bare marker `mark` owns a body: its first sibling other than a
 *  `QuoteMark` (in a blockquote, the next line's) starts on the line directly
 *  below the marker line. A bare item may start with at most one blank line —
 *  the marker line itself — so a block after a further blank line belongs to
 *  the enclosing block (CommonMark; stock Lezer 1.8.1 still spans `9.\n\n   x`,
 *  the patched build does not). Compares LINES, not `item.to` or a parse bound:
 *  a tree parsed only through the next line can still hold later nodes. */
function bareMarkerOwnsBody(state: EditorState, mark: SyntaxNode): boolean {
  const below = state.doc.lineAt(mark.from).number + 1;
  for (let c = mark.nextSibling; c !== null; c = c.nextSibling) {
    if (c.name !== "QuoteMark") {
      return state.doc.lineAt(c.from).number === below;
    }
  }
  return false;
}

/** A bare marker (nothing after it on its line) that owns no body below. */
function isBodilessBareMarker(state: EditorState, mark: SyntaxNode): boolean {
  return markerLineContent(state, mark) === null && !bareMarkerOwnsBody(state, mark);
}

/** The blank lines strictly between lines `upper` and `lower`, as the span from
 *  the end of `upper` to the end of the last of them (empty when the two lines
 *  are adjacent). Null when one of them is not blank: nothing can be moved.
 *
 *  THE BARE-MARKER RULE shared by every list edit: CommonMark ends a bare item at
 *  a blank line right after its marker, so a bare marker owns only a block
 *  DIRECTLY below it. An edit that leaves a bare marker on `upper` above the block
 *  it must own on `lower` moves this gap ABOVE the marker (Enter inserts the new
 *  marker after the gap; Tab / Shift-Tab use `liftGap`). A null gap makes the edit
 *  a no-op: the document and its numbering stay as they were. */
export function blankGapBetween(
  state: EditorState,
  upper: number,
  lower: number
): { from: number; to: number } | null {
  for (let n = upper + 1; n < lower; n++) {
    if (firstNonWsColumn(state, n) !== null) {
      return null;
    }
  }
  return { from: state.doc.line(upper).to, to: state.doc.line(Math.max(upper, lower - 1)).to };
}

/** Changes that move `gap` (from `blankGapBetween(state, upper, …)`) from below
 *  line `upper` to directly above it: `gap.to - gap.from` chars land before the
 *  line. */
function liftGap(
  state: EditorState,
  upper: number,
  gap: { from: number; to: number }
): ChangeSpec[] {
  if (gap.from === gap.to) {
    return [];
  }
  return [
    { from: gap.from, to: gap.to },
    {
      from: state.doc.line(upper).from,
      insert: `${state.doc.sliceString(gap.from + 1, gap.to)}\n`,
    },
  ];
}

/** True when the item has no continuable content: a bare `- ` / `1. ` that
 *  owns no body (`bareMarkerOwnsBody`; `-\n  text` / `-\n  - child` are NOT
 *  empty — the Enter and outdent empty arms would delete or strand that body), a
 *  content-less bare task marker (`- [ ]`, which the grammar leaves as a 3-byte
 *  Paragraph), or a `Task` node with only whitespace after its 3-byte
 *  `TaskMarker` (`- [ ] ` / `- [x] ` — the just-typed empty task, which the
 *  grammar emits as a `Task`, not a content-less Paragraph). Re-homed from
 *  `list-continuation-keymap.ts`'s private helper to take the ITEM (deriving
 *  `content` internally) rather than the content node, so callers besides
 *  Enter-continuation (planners) can share it without re-deriving `content`
 *  themselves. */
export function isEmptyItem(state: EditorState, item: SyntaxNode): boolean {
  const mark = listMarkOf(item);
  const content = mark === null ? null : markerLineContent(state, mark);
  if (content === null) {
    return mark === null || !bareMarkerOwnsBody(state, mark);
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

/** The marker + trailing space Enter-continuation would insert to continue
 *  `item` — bullet → `"<glyph> "`; ordered → `"<number+1><delim> "`; a task
 *  predecessor (detected via `isTaskItem`, so a content-less `- [ ]` counts)
 *  appends `"[ ] "` (ALWAYS unchecked, regardless of the predecessor's checked
 *  state). Null for a non-list item or a malformed ordered marker. Extracted
 *  from `continueListOnEnter`'s inline marker construction so the shared
 *  `renumberRun` caller and Enter build the identical string. */
export function continuationMarkerFor(state: EditorState, item: SyntaxNode): string | null {
  const mark = listMarkOf(item);
  if (mark === null) {
    return null;
  }
  const ordered = item.parent?.name === "OrderedList";
  const bullet = item.parent?.name === "BulletList";
  if (!ordered && !bullet) {
    return null;
  }
  let base: string;
  if (bullet) {
    base = state.doc.sliceString(mark.from, mark.to);
  } else {
    const shape = parseListMark(state.doc.sliceString(mark.from, mark.to));
    if (shape === null || shape.kind !== "ordered") {
      return null;
    }
    const next = orderedShape(shape.number + 1, shape.delim);
    if (next === null) {
      return null; // 9-digit ListMark cap — fail closed, same as renumberRun
    }
    base = formatMarker(next);
  }
  return isTaskItem(state, item) ? `${base} [ ] ` : `${base} `;
}

/** For each following `ListItem` sibling of `afterItem` within its
 *  `OrderedList`, rewrite its `ListMark` number by the SAME delta — the delta
 *  that would make an item immediately following `afterItem` become
 *  `startNumber` (i.e. `delta = startNumber - (afterItem's own number + 1)`)
 *  — preserving every sibling's own gap from the next (a user-typed
 *  `1. / 5. / 9.` run stays `1. / 5. / 10.` after inserting a `6.` after `5.`,
 *  not resequenced to `1. / 5. / 6.`). Anchored on `afterItem`'s OWN number
 *  (not the first following sibling's) so a caller inserting exactly one new
 *  item always passes `startNumber = <new item's number> + 1` and gets a
 *  uniform `+1` shift regardless of gaps in the existing run. Each sibling's
 *  own delimiter is preserved. Uses the Lezer sibling relationship — NOT a
 *  line scan — so it is correct across lazy-continuation lines (inside a
 *  sibling item, not between siblings), blockquote-prefixed lists (positions
 *  are absolute), and tab-mixed indent.
 *
 *  Recompute each rewritten sibling's content column because a tab after the
 *  marker can absorb a width change. Shift its own lines to that column to
 *  keep nested content under the rewritten marker.
 *
 *  Fail-closed: a null `ensureSyntaxTree` (parse did not reach EOF within
 *  budget — the list tail may be unparsed) or any resulting marker out of the
 *  supported 0..9-digit range — over cap (`@lezer/markdown` stops treating a
 *  10+-digit run as a ListMark) OR driven NEGATIVE (below 0) by a delta (which
 *  `ORDERED_RE` rejects = corrupt Markdown; `0.` itself stays valid), both
 *  gated by `orderedShape` — returns `[]` rather than emitting a split-brain /
 *  corrupting renumber. */
export function renumberRun(
  state: EditorState,
  afterItem: SyntaxNode,
  startNumber: number
): ChangeSpec[] {
  if (afterItem.parent?.name !== "OrderedList") {
    return [];
  }
  const afterMark = listMarkOf(afterItem);
  if (afterMark === null) {
    return [];
  }
  const afterShape = parseListMark(state.doc.sliceString(afterMark.from, afterMark.to));
  if (afterShape === null || afterShape.kind !== "ordered") {
    return [];
  }
  const delta = startNumber - (afterShape.number + 1);
  const tree = ensureSyntaxTree(state, state.doc.length, EOF_BUDGET);
  if (tree === null) {
    warnBudgetMiss("renumberRun", state);
    return [];
  }
  const changes: ChangeSpec[] = [];
  for (let sib = afterItem.nextSibling; sib !== null; sib = sib.nextSibling) {
    if (sib.name !== "ListItem") {
      continue;
    }
    const sibMark = listMarkOf(sib);
    if (sibMark === null) {
      continue;
    }
    const shape = parseListMark(state.doc.sliceString(sibMark.from, sibMark.to));
    if (shape === null || shape.kind !== "ordered") {
      continue;
    }
    const next = orderedShape(shape.number + delta, shape.delim);
    if (next === null) {
      return []; // out of the 0..9-digit ListMark range (over cap OR driven
      // negative by the delta) — fail closed rather than emit a corrupt marker
    }
    const newMarker = formatMarker(next);
    changes.push({ from: sibMark.from, to: sibMark.to, insert: newMarker });
    const { from, text } = state.doc.lineAt(sibMark.from);
    const markFromRel = sibMark.from - from;
    const markToRel = sibMark.to - from;
    const newText = text.slice(0, markFromRel) + newMarker + text.slice(markToRel);
    const newContentCol = contentColumnFromMarkerLine(
      newText,
      markFromRel + newMarker.length,
      state.tabSize
    );
    changes.push(...shiftOwnLines(state, sib, newContentCol));
  }
  return changes;
}

/** The parse tree budget (ms) used to reach EOF. Matches `renumberRun` /
 *  `resolveListItemThrough` — big lists resolve within this on the seed path. */
const EOF_BUDGET = 50;

/** Dev-only signal that a planner fell back to a no-op because
 *  `ensureSyntaxTree` did NOT reach EOF within budget — distinct from a genuine
 *  STRUCTURAL no-op (a well-parsed doc with no list item at the caret). On a
 *  large doc a budget miss is retryable, so surfacing it separates "nothing to
 *  do" from "give it another key press". Gated on `QUOLL_PERF` so production
 *  behaviour (and the packaged .vsix) is byte-identical — dead-coded out — and
 *  the unit suite (QUOLL_PERF=false) stays quiet; the Tab/Shift-Tab result is
 *  the same `{ kind: "noop" }` either way. */
export function warnBudgetMiss(where: string, state: EditorState): void {
  if (QUOLL_PERF) {
    console.warn(
      `[quoll] ${where}: parse did not reach EOF within budget — list transform no-op (retryable)`,
      { docLength: state.doc.length, budgetMs: EOF_BUDGET }
    );
  }
}

/** Re-resolve the innermost `ListItem` for the line containing `headPos` from an
 *  EOF-bounded tree (mirrors `list-continuation-keymap.ts`'s `resolveListItemThrough`,
 *  kept private here so the planner owns its resolution). The caret-line-bounded
 *  tree that `listItemAt` builds truncates the item's forced-children and
 *  destination followers (they live BELOW the caret), so the planner MUST parse
 *  to `state.doc.length`.
 *
 *  Probes the line's first non-whitespace column (NOT the raw `headPos`), the
 *  same as `listItemAt`: a caret at end-of-line / EOF biased forward
 *  (`resolveInner(headPos, 1)`) overshoots an empty marker line's `ListItem`
 *  into `Document`; the first non-whitespace char (the `ListMark` itself on an
 *  empty item) is squarely inside the item. Blank lines probe at `line.from`.
 *  Null when the parse did not reach EOF within budget (fail-closed) or the line
 *  is not inside a list item. */
function resolveItemAtEof(state: EditorState, headPos: number): SyntaxNode | null {
  const tree = ensureSyntaxTree(state, state.doc.length, EOF_BUDGET);
  if (tree === null) {
    warnBudgetMiss("resolveItemAtEof", state);
    return null; // budget miss (retryable), NOT a structural no-op — a non-null
    // tree with no list item at the caret returns null silently below.
  }
  const line = state.doc.lineAt(headPos);
  const wsLen = line.text.length - line.text.trimStart().length;
  const probe = line.text.trim() === "" ? line.from : line.from + wsLen;
  let node: SyntaxNode | null = tree.resolveInner(probe, 1);
  while (node !== null && node.name !== "ListItem") {
    node = node.parent;
  }
  return node;
}

/** The parent run's marker shape ADOPTED for the promoted item — bullet parents
 *  yield their glyph; ordered parents yield `parentNumber + 1` (the promoted
 *  item takes the slot right after the parent) with the parent's delimiter.
 *  Null when the parent carries no valid ListMark shape (grammar drift). */
function adoptedShapeFrom(state: EditorState, parent: SyntaxNode): ListMarkShape | null {
  const parentMark = listMarkOf(parent);
  if (parentMark === null) {
    return null;
  }
  const parentShape = parseListMark(state.doc.sliceString(parentMark.from, parentMark.to));
  if (parentShape === null) {
    return null;
  }
  if (parentShape.kind === "bullet") {
    return { kind: "bullet", glyph: parentShape.glyph };
  }
  return orderedShape(parentShape.number + 1, parentShape.delim);
}

/** The result of a list indent / outdent planner: a discriminated union so a
 *  no-op is a distinct variant, not an empty `changes: []` sentinel the caller
 *  must recognise. The `edit` variant couples `changes` with the optional
 *  `selection` (the empty-item caret) — a no-op carries neither, so a
 *  `{ changes: [], selection }` (nonsensical: the caller would early-return and
 *  drop the selection) is now unrepresentable. */
export type ListEditPlan =
  | { kind: "noop" }
  | { kind: "edit"; changes: ChangeSpec[]; selection?: SelectionRange };

/** Plan a marker-adopting Shift-Tab outdent for the item covering `headPos`:
 *  promote it to its parent's level, ADOPTING the destination run's marker
 *  (bullet glyph ↔ ordered next-number), renumbering the destination run, and
 *  re-homing the item's OLD following siblings as forced children. For an EMPTY
 *  item the synthesized marker also adopts the parent's task-ness (`[ ] ` iff
 *  the parent is task-like; a plain parent drops any checkbox the empty item
 *  had) and the returned `selection` places the caret right after it so the
 *  user keeps typing.
 *
 *  Returns `{ kind: "noop" }` — never throws — for: a null EOF parse
 *  (fail-closed), a caret not in a list item, a caret in code, a top-level item
 *  (no parent to promote to), or a 9-digit renumber overflow.
 *
 *  Disjointness: each line gets at most one whitespace shift — a marker line
 *  by its marker-column delta (`shiftMarkerLine`), a body line by its item's
 *  content-column shift (`shiftOwnLines`, to the content column read off the
 *  rewritten marker line, which folds a forced child's re-indent and
 *  marker-width change into one shift). Marker-text replacements
 *  sit on the adjacent `ListMark` spans and compose separately. `renumberRun` is called
 *  for the DESTINATION run only (the parent's top-level followers touch
 *  different lines than the re-homed forced children). */
export function planOutdentItem(state: EditorState, headPos: number): ListEditPlan {
  if (caretInCode(state, headPos)) {
    return { kind: "noop" };
  }
  const item = resolveItemAtEof(state, headPos);
  if (item === null) {
    return { kind: "noop" };
  }
  const mark = listMarkOf(item);
  if (mark === null) {
    return { kind: "noop" };
  }
  const parent = destinationForOutdent(item);
  if (parent === null) {
    return { kind: "noop" }; // top-level — nothing to promote to
  }
  const parentMark = listMarkOf(parent);
  if (parentMark === null) {
    return { kind: "noop" };
  }
  const adopted = adoptedShapeFrom(state, parent);
  if (adopted === null) {
    return { kind: "noop" };
  }
  const parentOrdered = adopted.kind === "ordered";

  const itemMarkCol = columnAt(state, mark.from);
  const parentMarkCol = columnAt(state, parentMark.from);
  const markerLine = state.doc.lineAt(mark.from);

  const changes: ChangeSpec[] = [];
  let selection: SelectionRange | undefined;

  const empty = isEmptyItem(state, item);

  // --- Marker rewrite + the moved item's own-line shift ------------------
  // The bare LIST-marker glyph width (`-` / `10.`) the promoted item adopts —
  // the nesting geometry driver (a child nests at `markerCol + listMarkerLen +
  // 1`). Distinct from the empty path's `newMarker` (a full continuation string
  // incl. trailing space + optional `[ ] `, used only for the caret) so a
  // task-ness `[ ] ` never leaks into the content-column math. (`adopted` came
  // from `orderedShape`, so its number is already within the 0..9-digit range —
  // no separate cap re-check here.)
  const listMarkerLen = formatMarker(adopted).length;
  // Marker-line whitespace shift is common to both paths: promote the marker
  // column to the parent's. (The marker-width change itself rides the ListMark /
  // marker-region replacement below, an adjacent change.)
  const markerShift = shiftMarkerLine(state, mark, parentMarkCol - itemMarkCol);
  if (markerShift !== null) {
    changes.push(markerShift);
  }
  if (empty) {
    // Replace the WHOLE marker region (`mark.from..line.to`, possibly incl.
    // `[ ] ` bytes) with the destination-adopted continuation marker: this
    // yields next-ordinal / glyph AND `[ ] ` iff the parent is task-like (the
    // empty-only task-ness rule; a plain parent drops any checkbox). An empty
    // item has no own body lines, so there is no content-column re-anchor.
    const newMarker = continuationMarkerFor(state, parent);
    if (newMarker === null) {
      return { kind: "noop" };
    }
    changes.push({ from: mark.from, to: markerLine.to, insert: newMarker });
    // A bare promoted marker must keep its first forced child directly below it.
    const firstForced = followingListItems(item)[0];
    let liftedChars = 0;
    if (firstForced !== undefined && parseListMark(newMarker.trim()) !== null) {
      const gap = blankGapBetween(
        state,
        markerLine.number,
        state.doc.lineAt(firstForced.from).number
      );
      if (gap === null) {
        return { kind: "noop" };
      }
      changes.push(...liftGap(state, markerLine.number, gap));
      liftedChars = gap.to - gap.from;
    }
    // Caret right after the synthesized marker, in POST-transform coords: the
    // marker-line shift and a lifted gap are the only changes ahead of it, so
    // offset by the chars that shift removed (on a tab-indented line chars !=
    // columns, and a column count would overshoot the shortened line → RangeError
    // in dispatch) and by the gap moved above the marker.
    const removedChars =
      markerShift === null ? 0 : markerShift.to - markerShift.from - markerShift.insert.length;
    selection = EditorSelection.cursor(mark.from - removedChars + liftedChars + newMarker.length);
  } else {
    // Non-empty: adopt only the marker KIND — replace the ListMark span; the
    // item's content bytes (incl. its own `[ ]`/`[x]`) are untouched.
    changes.push({ from: mark.from, to: mark.to, insert: formatMarker(adopted) });
    // Own body/descendant lines re-anchor to the NEW content column.
    changes.push(
      ...shiftOwnLines(
        state,
        item,
        contentColumnAfterMove(state, mark, parentMarkCol, formatMarker(adopted))
      )
    );
  }

  // --- Forced children (the item's OLD following siblings) --------------
  // Text order forces them to become the promoted item's children: re-indent
  // each of their lines to land at the promoted item's NEW content column, and
  // renumber them from 1 if they were ordered. Each own line is shifted once,
  // to the child's new content column read off its rewritten marker line.
  // The promoted item's REAL post-transform content column (its marker->content
  // gap is preserved on the non-empty path; the empty path synthesizes a
  // single-space marker).
  const promotedContentCol = empty
    ? parentMarkCol + listMarkerLen + 1
    : contentColumnAfterMove(state, mark, parentMarkCol, formatMarker(adopted));
  const forced = followingListItems(item);
  let forcedOrdinal = 1;
  for (const child of forced) {
    const childMark = listMarkOf(child);
    if (childMark === null) {
      continue;
    }
    const childMarkCol = columnAt(state, childMark.from);
    const reindentDelta = promotedContentCol - childMarkCol;
    // Renumber an ordered forced child from 1 under the new parent.
    let newChildMarker = state.doc.sliceString(childMark.from, childMark.to);
    const childShape = parseListMark(state.doc.sliceString(childMark.from, childMark.to));
    if (childShape !== null && childShape.kind === "ordered") {
      const childAdopted = orderedShape(forcedOrdinal, childShape.delim);
      if (childAdopted === null) {
        return { kind: "noop" }; // 9-digit cap — fail closed
      }
      newChildMarker = formatMarker(childAdopted);
      changes.push({ from: childMark.from, to: childMark.to, insert: newChildMarker });
      forcedOrdinal++;
    }
    // The forced child's marker line shifts by the re-indent only (its own
    // marker-width change rides the ListMark replacement above).
    const childShift = shiftMarkerLine(state, childMark, reindentDelta);
    if (childShift !== null) {
      changes.push(childShift);
    }
    // The forced child's OWN body/descendant lines re-anchor to its new content col.
    changes.push(
      ...shiftOwnLines(
        state,
        child,
        contentColumnAfterMove(state, childMark, promotedContentCol, newChildMarker)
      )
    );
  }

  // --- Destination renumber (the parent's OLD top-level followers) ------
  // The promoted item takes parentNumber+1, so the parent's followers shift to
  // +2, +3, …. `renumberRun(parent, parentNumber + 2)` yields that uniform +1.
  // (adopted.number === parentNumber + 1, so parentNumber + 2 === adopted.number
  // + 1.) `renumberRun` is itself fail-closed on a 9-digit overflow / null parse
  // (returns []), which composes here as "adopt the marker, leave the followers"
  // — the same conservative degrade its Enter-continuation caller relies on.
  if (parentOrdered && adopted.kind === "ordered") {
    changes.push(...renumberRun(state, parent, adopted.number + 1));
  }

  // `selection` is undefined on the non-empty path; the `edit` variant's optional
  // `selection` carries it either way (the dispatch shell's `=== undefined` guard
  // drops an undefined one before it reaches `view.dispatch`).
  return { kind: "edit", changes, selection };
}

/** The destination child-run `item` would JOIN when nesting under `parent`:
 *  `parent`'s LAST child is a list node AND nothing non-blank follows it (so
 *  text order places `item` immediately after that run's last item). Returns the
 *  list node to adopt from, or null when a NEW nested run must be started (no
 *  child list, or the last child is a Paragraph after the list — the
 *  `Paragraph, List, Paragraph` shape). Lezer emits no blank-line child nodes,
 *  so `lastChild` being a list is exactly "the list is the parent's tail". */
function childRunToJoin(parent: SyntaxNode): SyntaxNode | null {
  const last = parent.lastChild;
  return last !== null && isListNode(last) ? last : null;
}

/** The marker shape `item` adopts when JOINING `childRun`: continue that run's
 *  numbering (ordered → last item's number + 1, run's delim) or its glyph
 *  (bullet). Null on grammar drift. */
function adoptedShapeForJoin(state: EditorState, childRun: SyntaxNode): ListMarkShape | null {
  const last = lastListItemOf(childRun);
  if (last === null) {
    return null;
  }
  const mark = listMarkOf(last);
  if (mark === null) {
    return null;
  }
  const shape = parseListMark(state.doc.sliceString(mark.from, mark.to));
  if (shape === null) {
    return null;
  }
  if (shape.kind === "bullet") {
    return { kind: "bullet", glyph: shape.glyph };
  }
  return orderedShape(shape.number + 1, shape.delim);
}

/** The marker shape `item` keeps when starting a NEW nested run: its own
 *  kind/glyph/delim, but an ordered number RESET to 1 (Notion-style — a fresh
 *  nested run always restarts). Null on grammar drift. */
function newRunShapeFor(state: EditorState, item: SyntaxNode): ListMarkShape | null {
  const mark = listMarkOf(item);
  if (mark === null) {
    return null;
  }
  const shape = parseListMark(state.doc.sliceString(mark.from, mark.to));
  if (shape === null) {
    return null;
  }
  return shape.kind === "bullet"
    ? { kind: "bullet", glyph: shape.glyph }
    : orderedShape(1, shape.delim);
}

/** Plan a content-column-aware Tab indent for the item covering `headPos`: nest
 *  it under its indent destination (its preceding sibling, resolved ACROSS
 *  adjacent lists) at the destination parent's CONTENT column. The nested marker
 *  either ADOPTS the destination child-run's kind/glyph/delim and CONTINUES its
 *  numbering (when the item lands contiguously after an existing child list), or
 *  starts a NEW nested run (keeping the item's own kind/glyph/delim, resetting an
 *  ordered number to 1) and RENUMBERS the vacated outer run to close the gap.
 *
 *  Returns `{ kind: "noop" }` — never throws — for: a null EOF parse
 *  (fail-closed), a caret not in a list item, a caret in code, no indent
 *  destination (the doc's first list item), grammar drift, or a non-positive
 *  marker-column delta (already at/past the target — pathological alignment).
 *
 *  Disjointness (mirrors `planOutdentItem`): each line gets at most one
 *  whitespace shift — the marker line by
 *  `contentColumnOf(parent) - itemMarkCol`, the item's OWN body/descendant lines
 *  (`shiftOwnLines`) to the content column read off the rewritten marker line.
 *  `classifyItemLines` excludes lazy-continuation
 *  lines so a broken 2-space doc HEALS (the lazy tail is not dragged). The moved
 *  item's ListMark rewrite and the vacated-run renumber sit on DISJOINT spans
 *  (`renumberRun(item, item.ownNumber)` touches only the followers STAYING in the
 *  outer run, never `item`'s own marker), so there is no overlapping ChangeSpec. */
export function planIndentItem(state: EditorState, headPos: number): ListEditPlan {
  if (caretInCode(state, headPos)) {
    return { kind: "noop" };
  }
  const item = resolveItemAtEof(state, headPos);
  if (item === null) {
    return { kind: "noop" };
  }
  const mark = listMarkOf(item);
  if (mark === null) {
    return { kind: "noop" };
  }
  const parent = destinationForIndent(item);
  if (parent === null) {
    return { kind: "noop" }; // doc's first list item — nothing to nest under
  }

  // A bodiless bare destination takes `item` as its first block, which must sit
  // directly below the destination's marker.
  const parentMark = listMarkOf(parent);
  const lift: ChangeSpec[] = [];
  if (parentMark !== null && isBodilessBareMarker(state, parentMark)) {
    const upper = state.doc.lineAt(parentMark.from).number;
    const gap = blankGapBetween(state, upper, state.doc.lineAt(mark.from).number);
    if (gap === null) {
      return { kind: "noop" };
    }
    lift.push(...liftGap(state, upper, gap));
  }

  const targetCol = contentColumnOf(state, parent);
  const itemMarkCol = columnAt(state, mark.from);
  const markerDelta = targetCol - itemMarkCol;
  if (markerDelta <= 0) {
    return { kind: "noop" }; // already at/past the target — pathological alignment
  }

  // JOIN vs NEW run: joinable when the parent's tail is an existing child list.
  const childRun = childRunToJoin(parent);
  const adopted =
    childRun !== null ? adoptedShapeForJoin(state, childRun) : newRunShapeFor(state, item);
  if (adopted === null) {
    return { kind: "noop" }; // grammar drift OR a 9-digit-cap overflow that
    // `orderedShape` (inside the adopt helpers) rejected — fail closed either way
  }

  const newMarker = formatMarker(adopted);
  const changes: ChangeSpec[] = lift;

  // Marker rewrite (adopt the destination run's kind / continue-number, OR reset
  // to 1 for a new run) — a disjoint ListMark-span replacement.
  changes.push({ from: mark.from, to: mark.to, insert: newMarker });

  // Marker line shifts to the parent's content column; own body/descendant lines
  // re-anchor to the new content column. Both shift at their column boundary,
  // not the line start.
  const markerShift = shiftMarkerLine(state, mark, markerDelta);
  if (markerShift !== null) {
    changes.push(markerShift);
  }
  changes.push(
    ...shiftOwnLines(state, item, contentColumnAfterMove(state, mark, targetCol, newMarker))
  );

  // Vacated outer run: the item leaves a gap, so its OWN following siblings must
  // renumber down by one. `renumberRun(item, item.ownNumber)` yields exactly that
  // −1 uniform shift (delta = ownNumber − (ownNumber + 1)) and touches ONLY the
  // followers — never the item's own (already-rewritten) marker. A bullet outer
  // run / a null-parse / a 9-digit overflow degrades to `[]` (leave the run).
  const itemShape = parseListMark(state.doc.sliceString(mark.from, mark.to));
  if (item.parent?.name === "OrderedList" && itemShape !== null && itemShape.kind === "ordered") {
    changes.push(...renumberRun(state, item, itemShape.number));
  }

  return { kind: "edit", changes };
}
