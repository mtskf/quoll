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
  destinationForOutdent,
  followingListItems,
  listMarkOf,
  type SyntaxNode,
} from "./list-tree.js";

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

/** The parse tree budget (ms) used to reach EOF. Matches `renumberRun` /
 *  `resolveAtEof` — big lists resolve within this on the seed path. */
const EOF_BUDGET = 50;

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
    return null;
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
  return { kind: "ordered", number: parentShape.number + 1, delim: parentShape.delim };
}

/** The result of a marker-adopting outdent, or `null` for a structural no-op
 *  (top-level item, caret in code, non-list caret, fail-closed parse). */
export type OutdentPlan = { changes: ChangeSpec[]; selection?: SelectionRange };

/** Plan a marker-adopting Shift-Tab outdent for the item covering `headPos`:
 *  promote it to its parent's level, ADOPTING the destination run's marker
 *  (bullet glyph ↔ ordered next-number), renumbering the destination run, and
 *  re-homing the item's OLD following siblings as forced children. For an EMPTY
 *  item the synthesized marker also adopts the parent's task-ness (`[ ] ` iff
 *  the parent is task-like; a plain parent drops any checkbox the empty item
 *  had) and the returned `selection` places the caret right after it so the
 *  user keeps typing.
 *
 *  Returns `[]` (a `changes`-only no-op) — never throws — for: a null EOF parse
 *  (fail-closed), a caret not in a list item, a caret in code, a top-level item
 *  (no parent to promote to), or a 9-digit renumber overflow.
 *
 *  Disjointness: every whitespace shift is accumulated into ONE per-line net
 *  delta map so a forced child that is BOTH re-indented AND renumbered (width
 *  change) emits exactly ONE `ChangeSpec`. Marker-text replacements sit on
 *  disjoint `ListMark` spans and compose separately. `renumberRun` is called
 *  for the DESTINATION run only (the parent's top-level followers touch
 *  different lines than the re-homed forced children). */
export function planOutdentItem(state: EditorState, headPos: number): OutdentPlan {
  if (caretInCode(state, headPos)) {
    return { changes: [] };
  }
  const item = resolveItemAtEof(state, headPos);
  if (item === null) {
    return { changes: [] };
  }
  const mark = listMarkOf(item);
  if (mark === null) {
    return { changes: [] };
  }
  const parent = destinationForOutdent(item);
  if (parent === null) {
    return { changes: [] }; // top-level — nothing to promote to
  }
  const parentMark = listMarkOf(parent);
  if (parentMark === null) {
    return { changes: [] };
  }
  const adopted = adoptedShapeFrom(state, parent);
  if (adopted === null) {
    return { changes: [] };
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
  // task-ness `[ ] ` never leaks into the content-column math.
  if (adopted.kind === "ordered" && adopted.number > 999_999_999) {
    return { changes: [] }; // 9-digit cap — fail closed
  }
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
      return { changes: [] };
    }
    changes.push({ from: mark.from, to: markerLine.to, insert: newMarker });
    // Caret right after the synthesized marker, in POST-transform coords: the
    // leading whitespace collapses to `parentMarkCol` spaces, then the marker.
    // (Computed in new coords — `mark.from` is a pre-transform byte and the
    // whitespace removal before it would push an absolute cursor out of range.)
    selection = EditorSelection.cursor(markerLine.from + parentMarkCol + newMarker.length);
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
  const promotedContentCol = parentMarkCol + listMarkerLen + 1; // list marker + one space
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
      if (forcedOrdinal > 999_999_999) {
        return { changes: [] }; // 9-digit cap — fail closed
      }
      const newChildMarker = formatMarker({
        kind: "ordered",
        number: forcedOrdinal,
        delim: childShape.delim,
      });
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
  return selection === undefined ? { changes } : { changes, selection };
}
