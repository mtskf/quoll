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

import type { EditorState } from "@codemirror/state";

import { columnAt } from "./list-geometry.js";
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
