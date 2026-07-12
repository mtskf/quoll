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
import type { ChangeSpec, EditorState } from "@codemirror/state";

import { isContentlessTaskParagraph } from "../task-checkbox/task-marker-shape.js";
import { columnAt, findTaskMarker, isTaskItem } from "./list-geometry.js";
import { listMarkOf, type SyntaxNode } from "./list-tree.js";

export type ListMarkShape =
  | { kind: "bullet"; glyph: "-" | "*" | "+" }
  | { kind: "ordered"; number: number; delim: "." | ")" };

const ORDERED_RE = /^(\d{1,9})([.)])$/; // Lezer caps ordered ListMark at 9 digits

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
 *  the first non-whitespace char. MOVE-BY-COPY from `list-indent-keymap.ts`
 *  (kept there too — its old `shiftItemLines`/commands still use their own
 *  copy until the Task 5/6 consolidation; do not delete the original). */
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
    base = formatMarker({ kind: "ordered", number: shape.number + 1, delim: shape.delim });
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
 *  budget — the list tail may be unparsed) or any resulting marker exceeding
 *  9 digits (`@lezer/markdown` stops treating a 10+-digit run as a ListMark,
 *  the same cap `parseListMark` enforces) returns `[]` rather than emitting a
 *  split-brain / corrupting renumber. */
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
  const tree = ensureSyntaxTree(state, state.doc.length, 50);
  if (tree === null) {
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
    const n = shape.number + delta;
    if (n > 999_999_999) {
      return []; // would exceed Lezer's 9-digit ListMark cap — fail closed
    }
    const oldWidth = sibMark.to - sibMark.from;
    const newMarker = formatMarker({ kind: "ordered", number: n, delim: shape.delim });
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
