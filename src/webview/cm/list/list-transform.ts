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
 * Later tasks will build on these primitives to handle list-structure transforms
 * (indent/dedent, renumbering, marker rewriting).
 */

import { ensureSyntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
} from "@codemirror/state";

import { isContentlessTaskParagraph } from "../task-checkbox/task-marker-shape.js";
import { columnAt, findTaskMarker, isTaskItem } from "./list-geometry.js";
import {
  caretInCode,
  destinationForIndent,
  destinationForOutdent,
  followingListItems,
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

/** Build an ordered shape, or null when `number` is out of the 1..MAX range
 *  (the sole cap-enforcement point — callers propagate null as a fail-closed
 *  no-op instead of re-checking the literal). Guards BOTH bounds: `< 1` (a
 *  renumber delta can drive a follower negative, which `ORDERED_RE` rejects =
 *  corrupt Markdown) and `> MAX` (a 10+-digit run stops being a ListMark). */
export function orderedShape(number: number, delim: "." | ")"): ListMarkShape | null {
  return number >= 1 && number <= MAX_LIST_NUMBER ? { kind: "ordered", number, delim } : null;
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

/** Column where the item's content begins (its `ListMark`'s next sibling), with
 *  a fallback for an empty/malformed item so it is NEVER null: `markCol +
 *  markerLen + 1` (the CommonMark implied single-space content indent — the
 *  same convention `list-geometry.ts`'s `ownMarkerWidth` uses for an empty
 *  item's hang). This is a separate copy from `list-indent-keymap.ts`'s
 *  private `contentColumnOf` (which returns `null` on empty items — its
 *  `indentListItem`/`outdentListItem` callers treat that as a no-op); the two
 *  are consolidated when that module's commands are rewritten in a later task. */
export function contentColumnOf(state: EditorState, item: SyntaxNode): number {
  const mark = listMarkOf(item);
  if (mark === null) {
    return columnAt(state, item.from);
  }
  const markCol = columnAt(state, mark.from);
  const content = mark.nextSibling;
  if (content === null || content.from === content.to) {
    return markCol + (mark.to - mark.from) + 1;
  }
  return columnAt(state, content.from);
}

/** First non-whitespace column of `line`, or `null` when the line is blank /
 *  whitespace-only. */
function firstNonWsColumn(state: EditorState, lineNumber: number): number | null {
  const line = state.doc.line(lineNumber);
  if (line.text.trim() === "") {
    return null;
  }
  const wsLen = line.text.length - line.text.trimStart().length;
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
 *  non-whitespace column is >= the item's content column
 *  (`contentColumnOf(state, item)`). A line under that column is only part of
 *  the item by CommonMark laziness (e.g. a flush-left paragraph continuing a
 *  loosely-indented nested item) and is excluded — moving the item must not
 *  drag lazy text that isn't structurally the item's.
 *
 *  Note the marker line itself sits at the MARKER column (< content column by
 *  construction — e.g. `  - ddd` marker col 2 < content col 4), so it is
 *  bucketed by position (line 1) rather than by the column test — a naive
 *  "col >= content" test would wrongly exclude it from the item's own lines. */
export function classifyItemLines(
  state: EditorState,
  item: SyntaxNode
): { markerLine: number; ownLines: number[] } {
  const contentCol = contentColumnOf(state, item);
  const first = state.doc.lineAt(item.from).number;
  const last = state.doc.lineAt(Math.max(item.from, item.to - 1)).number;
  const markerLine = first;
  const ownLines: number[] = [];
  for (let n = first + 1; n <= last; n++) {
    const col = firstNonWsColumn(state, n);
    if (col !== null && col >= contentCol) {
      ownLines.push(n);
    }
  }
  return { markerLine, ownLines };
}

/** Number of leading-whitespace CHARS whose expanded columns reach `cols` (a
 *  straddling tab is counted whole → slight over-de-dent, documented). Stops at
 *  the first non-whitespace char. The sole copy — the former duplicate in
 *  `list-indent-keymap.ts` was removed when both indent/outdent commands became
 *  planner shells. */
export function leadingCharsForColumns(text: string, cols: number, tabSize: number): number {
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

/** True when the item has no continuable content: a bare `- ` / `1. `, a
 *  content-less bare task marker (`- [ ]`, which the grammar leaves as a 3-byte
 *  Paragraph), or a `Task` node with only whitespace after its 3-byte
 *  `TaskMarker` (`- [ ] ` / `- [x] ` — the just-typed empty task, which the
 *  grammar emits as a `Task`, not a content-less Paragraph). Re-homed from
 *  `list-continuation-keymap.ts`'s private helper to take the ITEM (deriving
 *  `content` internally) rather than the content node, so callers besides
 *  Enter-continuation (planners) can share it without re-deriving `content`
 *  themselves. */
export function isEmptyItem(state: EditorState, item: SyntaxNode): boolean {
  const content = listMarkOf(item)?.nextSibling ?? null;
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
 *  Width-aware (the latent bug this consolidation fixes): when a rewrite
 *  changes the marker's BYTE WIDTH (e.g. `9.` → `10.`, 1 digit → 2), the
 *  sibling's content column shifts, so its own body/descendant lines
 *  (`classifyItemLines(state, sib).ownLines`) must shift with it — otherwise a
 *  nested child that was exactly at the OLD content column falls out of the
 *  widened item (a genuinely nested child reads as a lazy/sibling line
 *  instead). Emits a leading-space insert (width grew) or removal (width
 *  shrank) for each own line, sized to the byte-width delta.
 *
 *  Fail-closed: a null `ensureSyntaxTree` (parse did not reach EOF within
 *  budget — the list tail may be unparsed) or any resulting marker out of the
 *  supported 1..9-digit range — over cap (`@lezer/markdown` stops treating a
 *  10+-digit run as a ListMark) OR driven below 1 by a negative delta (which
 *  `ORDERED_RE` rejects = corrupt Markdown), both gated by `orderedShape` —
 *  returns `[]` rather than emitting a split-brain / corrupting renumber. */
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
      return []; // out of the 1..9-digit ListMark range (over cap OR driven
      // negative by the delta) — fail closed rather than emit a corrupt marker
    }
    const oldWidth = sibMark.to - sibMark.from;
    const newMarker = formatMarker(next);
    changes.push({ from: sibMark.from, to: sibMark.to, insert: newMarker });
    const deltaWidth = newMarker.length - oldWidth;
    if (deltaWidth !== 0) {
      const { ownLines } = classifyItemLines(state, sib);
      for (const lineNo of ownLines) {
        const line = state.doc.line(lineNo);
        if (deltaWidth > 0) {
          changes.push({ from: line.from, insert: " ".repeat(deltaWidth) });
        } else {
          const remove = leadingCharsForColumns(line.text, -deltaWidth, state.tabSize);
          if (remove > 0) {
            changes.push({ from: line.from, to: line.from + remove });
          }
        }
      }
    }
  }
  return changes;
}

/** The parse tree budget (ms) used to reach EOF. Matches `renumberRun` /
 *  `resolveAtEof` — big lists resolve within this on the seed path. */
const EOF_BUDGET = 50;

/** Dev-only signal that a planner fell back to a no-op because
 *  `ensureSyntaxTree` did NOT reach EOF within budget — distinct from a genuine
 *  STRUCTURAL no-op (a well-parsed doc with no list item at the caret). On a
 *  large doc a budget miss is retryable, so surfacing it separates "nothing to
 *  do" from "give it another key press". Gated on `QUOLL_PERF` so production
 *  behaviour (and the packaged .vsix) is byte-identical — dead-coded out — and
 *  the unit suite (QUOLL_PERF=false) stays quiet; the Tab/Shift-Tab result is
 *  the same `{ kind: "noop" }` either way. */
function warnBudgetMiss(where: string, state: EditorState): void {
  if (QUOLL_PERF) {
    console.warn(
      `[quoll] ${where}: parse did not reach EOF within budget — list transform no-op (retryable)`,
      { docLength: state.doc.length, budgetMs: EOF_BUDGET }
    );
  }
}

/** Re-resolve the innermost `ListItem` for the line containing `headPos` from an
 *  EOF-bounded tree (mirrors `list-continuation-keymap.ts`'s `resolveAtEof`,
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

/** Add `delta` net columns to `line.from`'s accumulator entry — the disjointness
 *  guard: EVERY whitespace shift source (the moved item's marker line + own
 *  lines, forced-children re-indent, forced-children renumber width) funnels
 *  through this ONE map so a line touched by two sources yields ONE net
 *  `ChangeSpec`, never two overlapping ones (CodeMirror throws on overlap). */
function addLineDelta(map: Map<number, number>, lineFrom: number, delta: number): void {
  if (delta === 0) {
    return;
  }
  map.set(lineFrom, (map.get(lineFrom) ?? 0) + delta);
}

/** Materialise the accumulated per-line net column deltas into whitespace
 *  `ChangeSpec`s: a positive net prepends spaces, a negative net removes up to
 *  |net| leading-whitespace columns. Blank / whitespace-only lines and a
 *  net-zero entry emit nothing (no trailing-space noise). */
function materialiseLineDeltas(state: EditorState, map: Map<number, number>): ChangeSpec[] {
  const changes: ChangeSpec[] = [];
  for (const [lineFrom, delta] of map) {
    if (delta === 0) {
      continue;
    }
    const line = state.doc.lineAt(lineFrom);
    if (line.text.trim() === "") {
      continue;
    }
    if (delta > 0) {
      changes.push({ from: line.from, insert: " ".repeat(delta) });
    } else {
      const remove = leadingCharsForColumns(line.text, -delta, state.tabSize);
      if (remove > 0) {
        changes.push({ from: line.from, to: line.from + remove });
      }
    }
  }
  return changes;
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
 *  Disjointness: every whitespace shift is accumulated into ONE per-line net
 *  delta map so a forced child that is BOTH re-indented AND renumbered (width
 *  change) emits exactly ONE `ChangeSpec`. Marker-text replacements sit on
 *  disjoint `ListMark` spans and compose separately. `renumberRun` is called
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
  const lineDeltas = new Map<number, number>();
  let selection: SelectionRange | undefined;

  const empty = isEmptyItem(state, item);

  // --- Marker rewrite + the moved item's own-line shift ------------------
  // The bare LIST-marker glyph width (`-` / `10.`) the promoted item adopts —
  // the nesting geometry driver (a child nests at `markerCol + listMarkerLen +
  // 1`). Distinct from the empty path's `newMarker` (a full continuation string
  // incl. trailing space + optional `[ ] `, used only for the caret) so a
  // task-ness `[ ] ` never leaks into the content-column math. (`adopted` came
  // from `orderedShape`, so its number is already within the 1..9-digit range —
  // no separate cap re-check here.)
  const listMarkerLen = formatMarker(adopted).length;
  const oldMarkerLen = mark.to - mark.from;
  // Marker-line whitespace shift is common to both paths: promote the marker
  // column to the parent's. (The marker-width change itself rides the ListMark /
  // marker-region replacement below, not the whitespace map.)
  addLineDelta(lineDeltas, markerLine.from, parentMarkCol - itemMarkCol);
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
    // Caret right after the synthesized marker, in POST-transform coords,
    // derived from the CHARS removed ahead of the marker (the same
    // `leadingCharsForColumns` count `materialiseLineDeltas` will apply for the
    // `parentMarkCol - itemMarkCol` marker-line delta), NOT from the column
    // count. On a tab-indented line surviving chars != surviving columns, so
    // adding a column count to `markerLine.from` overshoots the shortened line
    // and `view.dispatch` throws RangeError (swallowed by applyShift = the whole
    // outdent silently lost). Removed chars keep the caret in range.
    const removedChars = leadingCharsForColumns(
      markerLine.text,
      itemMarkCol - parentMarkCol,
      state.tabSize
    );
    selection = EditorSelection.cursor(mark.from - removedChars + newMarker.length);
  } else {
    // Non-empty: adopt only the marker KIND — replace the ListMark span; the
    // item's content bytes (incl. its own `[ ]`/`[x]`) are untouched.
    changes.push({ from: mark.from, to: mark.to, insert: formatMarker(adopted) });
    // Own body/descendant lines re-anchor to the NEW content column: the
    // marker-column shift PLUS the marker-width delta.
    const contentDelta = parentMarkCol - itemMarkCol + (listMarkerLen - oldMarkerLen);
    for (const lineNo of classifyItemLines(state, item).ownLines) {
      addLineDelta(lineDeltas, state.doc.line(lineNo).from, contentDelta);
    }
  }

  // --- Forced children (the item's OLD following siblings) --------------
  // Text order forces them to become the promoted item's children: re-indent
  // each of their lines to land at the promoted item's NEW content column, and
  // renumber them from 1 if they were ordered (folding any width change into
  // the same per-line net delta — NOT a second ChangeSpec).
  // The promoted item's REAL post-transform content column. The non-empty path
  // replaces ONLY the ListMark span, so the item's original marker->content gap
  // (which may be > 1 for an aligned run like `1.  a`) is preserved in the
  // output; hard-coding gap 1 here would compute a content column LEFT of where
  // the item actually sits, so a forced child at the true column reads as a
  // top-level sibling instead of nesting (corrupting the outer run). The empty
  // path synthesizes a single-space marker (gap 1).
  const gap = Math.max(1, contentColumnOf(state, item) - (itemMarkCol + oldMarkerLen));
  const promotedContentCol = parentMarkCol + listMarkerLen + (empty ? 1 : gap);
  const forced = followingListItems(item);
  let forcedOrdinal = 1;
  for (const child of forced) {
    const childMark = listMarkOf(child);
    if (childMark === null) {
      continue;
    }
    const childMarkCol = columnAt(state, childMark.from);
    const reindentDelta = promotedContentCol - childMarkCol;
    // Renumber an ordered forced child from 1 under the new parent; fold the
    // marker-width delta into the child's own-line re-indent so a width cross
    // (e.g. `9.`→`10.` or `10.`→`1.`) never doubles up on a body line.
    let childWidthDelta = 0;
    const childShape = parseListMark(state.doc.sliceString(childMark.from, childMark.to));
    if (childShape !== null && childShape.kind === "ordered") {
      const childAdopted = orderedShape(forcedOrdinal, childShape.delim);
      if (childAdopted === null) {
        return { kind: "noop" }; // 9-digit cap — fail closed
      }
      const newChildMarker = formatMarker(childAdopted);
      changes.push({ from: childMark.from, to: childMark.to, insert: newChildMarker });
      childWidthDelta = newChildMarker.length - (childMark.to - childMark.from);
      forcedOrdinal++;
    }
    // The forced child's marker line shifts by the re-indent only (its own
    // marker-width change rides the ListMark replacement above).
    addLineDelta(lineDeltas, state.doc.lineAt(childMark.from).from, reindentDelta);
    // The forced child's OWN body/descendant lines shift by re-indent PLUS the
    // child's marker-width delta (they re-anchor to the child's new content col).
    for (const lineNo of classifyItemLines(state, child).ownLines) {
      addLineDelta(lineDeltas, state.doc.line(lineNo).from, reindentDelta + childWidthDelta);
    }
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

  changes.push(...materialiseLineDeltas(state, lineDeltas));
  return selection === undefined
    ? { kind: "edit", changes }
    : { kind: "edit", changes, selection };
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
 *  Disjointness (mirrors `planOutdentItem`): every whitespace shift funnels
 *  through ONE per-line net-delta map. Two deltas — the marker line via
 *  `contentColumnOf(parent) - itemMarkCol`, and the item's OWN body/descendant
 *  lines (`classifyItemLines(item).ownLines`) additionally by
 *  `newMarkerLen - oldMarkerLen`. `classifyItemLines` excludes lazy-continuation
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

  const oldMarkerLen = mark.to - mark.from;
  const newMarker = formatMarker(adopted);
  const changes: ChangeSpec[] = [];
  const lineDeltas = new Map<number, number>();

  // Marker rewrite (adopt the destination run's kind / continue-number, OR reset
  // to 1 for a new run) — a disjoint ListMark-span replacement.
  changes.push({ from: mark.from, to: mark.to, insert: newMarker });

  // Marker line shifts to the parent's content column; own body/descendant lines
  // additionally absorb the marker-width change so they re-anchor to the new
  // content column. Both funnel through the one net-delta map.
  addLineDelta(lineDeltas, state.doc.lineAt(mark.from).from, markerDelta);
  const contentDelta = markerDelta + (newMarker.length - oldMarkerLen);
  for (const lineNo of classifyItemLines(state, item).ownLines) {
    addLineDelta(lineDeltas, state.doc.line(lineNo).from, contentDelta);
  }

  // Vacated outer run: the item leaves a gap, so its OWN following siblings must
  // renumber down by one. `renumberRun(item, item.ownNumber)` yields exactly that
  // −1 uniform shift (delta = ownNumber − (ownNumber + 1)) and touches ONLY the
  // followers — never the item's own (already-rewritten) marker. A bullet outer
  // run / a null-parse / a 9-digit overflow degrades to `[]` (leave the run).
  const itemShape = parseListMark(state.doc.sliceString(mark.from, mark.to));
  if (item.parent?.name === "OrderedList" && itemShape !== null && itemShape.kind === "ordered") {
    changes.push(...renumberRun(state, item, itemShape.number));
  }

  changes.push(...materialiseLineDeltas(state, lineDeltas));
  return { kind: "edit", changes };
}
