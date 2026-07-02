// Unified list geometry. Two responsibilities, both pure functions of
// (EditorState, Lezer node):
//   1. resolveTaskMarkerGeometry — the SINGLE source of truth for the
//      bullet/ordered task-marker fold policy (Codex F7). Both
//      task-checkbox-reveal (checkbox replace span) and list-hang-indent
//      (rendered prefix column) derive `foldFrom` from here, so the two
//      can never drift.
//   2. resolveListItemHang — the recursive hang-geometry resolver (Codex
//      F1). Walks the ListItem ancestor chain, re-basing each item one
//      NEST_STEP past its parent's RENDERED content column across task folds
//      (so a child N task levels deep inherits the accumulated checkbox shift
//      AND one outline step per level) while preserving source indentation
//      across plain-only chains. The outline step overturns PR1's flush
//      alignment (Codex F2), which read as un-nested under the wide checkbox
//      (user dogfooding 2026-06-21).
//      The optional `hiddenPrefixCols` parameter (default 0) subtracts the
//      column width of any blockquote `> ` prefix that blockquote-reveal
//      hides caret-off (computed by the provider's `blockquotePrefixCols`).
//      0 for non-blockquoted lines and for lines where the caret reveals the
//      prefix — the original physical-column geometry is preserved in those
//      cases.
//
// `columnAt` is also EXPORTED so the list-hang-indent provider can reuse it
// in `blockquotePrefixCols` without importing the separate `@codemirror/state`
// `countColumn` utility directly.
//
// See .claude/plans/2026-06-21-unified-list-geometry-resolver.md for the
// model derivation (CM's `paddingLeft + min(0, textIndent)` first-line
// mapping) and the worked INDENT/PAD invariant table.

import type { syntaxTree } from "@codemirror/language";
import { countColumn, type EditorState } from "@codemirror/state";

import { TASK_MARKER_RE } from "./task-checkbox-command.js";

// `@lezer/common` is a transitive-only dep pnpm does not hoist (supply-chain
// default-deny) — derive SyntaxNode from syntaxTree's return type. Same
// strategy as types.ts / task-checkbox-reveal.ts.
type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

/** The CSS token for the rendered task checkbox column width. */
const MARKER = "var(--quoll-task-marker-width)";

/** Find the leading 3-byte `TaskMarker` child of a `Task` node + its checked
 *  state, or null on grammar drift / mid-rebuild (first child not a
 *  `TaskMarker`, not exactly 3 bytes, or the slice is not `[ ]`/`[x]`/`[X]`).
 *  Moved verbatim from task-checkbox-reveal.ts so marker resolution has one
 *  home (Codex F7). */
export function findTaskMarker(
  state: EditorState,
  task: SyntaxNode
): { from: number; to: number; checked: boolean } | null {
  const first = task.firstChild;
  if (first === null || first.name !== "TaskMarker") {
    return null;
  }
  if (first.to - first.from !== 3) {
    return null;
  }
  const slice = state.doc.sliceString(first.from, first.to);
  if (!TASK_MARKER_RE.test(slice)) {
    return null;
  }
  const middle = slice.charAt(1);
  return { from: first.from, to: first.to, checked: middle === "x" || middle === "X" };
}

export type TaskMarkerGeometry = {
  /** Start of the `ListMark` (`-`/`*`/`+`/`N.`) opening the item. */
  listMarkFrom: number;
  /** Start of the 3-byte `[ ]` `TaskMarker`. */
  taskMarkerFrom: number;
  /** End of the `TaskMarker` (taskMarkerFrom + 3). */
  taskMarkerTo: number;
  checked: boolean;
  /** True when the wrapping list is a `BulletList` — the `- ` folds into the
   *  checkbox. False for `OrderedList` / grammar drift — the visible prefix
   *  stays, only `[ ]` folds. */
  isBullet: boolean;
  /** The byte from which the RENDERED marker prefix begins: `listMarkFrom` for
   *  a bullet task (fold `- `), `taskMarkerFrom` otherwise (keep `N. `
   *  visible). The checkbox replace-start AND the hang prefix-column both
   *  derive from this single field — the F7 contract. */
  foldFrom: number;
};

/** Resolve the rendered task-marker geometry for a `Task` node, or null when
 *  it has no valid 3-byte marker (then neither consumer renders a checkbox /
 *  task hang). The fold policy degrades conservatively: a valid marker with a
 *  non-BulletList (ordered) or malformed wrapper keeps the visible prefix
 *  (`foldFrom = taskMarkerFrom`), exactly the pre-PR2 reveal fallback. */
export function resolveTaskMarkerGeometry(
  state: EditorState,
  task: SyntaxNode
): TaskMarkerGeometry | null {
  const marker = findTaskMarker(state, task);
  if (marker === null) {
    return null;
  }
  const listItem = task.parent;
  const listMark = listItem !== null && listItem.name === "ListItem" ? listItem.firstChild : null;
  const listMarkFrom =
    listMark !== null && listMark.name === "ListMark" ? listMark.from : marker.from;
  const isBullet =
    listItem !== null && listItem.name === "ListItem" && listItem.parent?.name === "BulletList";
  return {
    listMarkFrom,
    taskMarkerFrom: marker.from,
    taskMarkerTo: marker.to,
    checked: marker.checked,
    isBullet,
    foldFrom: isBullet ? listMarkFrom : marker.from,
  };
}

/** A list-geometry column: `ch·1ch + markers·var(--quoll-task-marker-width)`.
 *  `ch` may be negative in intermediate render-shift arithmetic; `markers` is
 *  >= 0 for every value that reaches serialize() — renderShift only subtracts
 *  the markers:0 sourceMarkColumn, so a marker term added by a task ancestor is
 *  never subtracted away. The final serialized INDENT/PAD are non-negative. */
type Col = { ch: number; markers: number };

const add = (a: Col, b: Col): Col => ({ ch: a.ch + b.ch, markers: a.markers + b.markers });
const subtract = (a: Col, b: Col): Col => ({ ch: a.ch - b.ch, markers: a.markers - b.markers });

/** One outline step added when a child is re-based across a TASK parent's fold.
 *  PR1 placed task-nested children FLUSH at the parent content column (Codex
 *  F2); user dogfooding (2026-06-21) found that flush reads as un-nested under
 *  the task's WIDE checkbox widget (var(--quoll-task-marker-width)) — the
 *  child marker's left edge aligned with the parent's text. Stepping one
 *  NEST_STEP (2 source cols) right makes the nesting visible. Plain parents
 *  (thin `-` marker) keep flush — the source indent already shows nesting.
 *  Value adjustable; pinned by the hang tests. */
const NEST_STEP: Col = { ch: 2, markers: 0 };

/** The CSS token for one source-indentation column. A list line renders in the
 *  proportional prose font (`var(--vscode-font-family)`), where a source
 *  character is NARROWER than `1ch` (= the `0` glyph). Using bare `ch` made
 *  `text-indent` over-pull, so wrapped continuation lines hung deeper than the
 *  item's first-line text (the nested-bullet over-indent bug). `--quoll-prose-space`
 *  is the measured space advance of the prose font (set by prose-space-metric.ts);
 *  the `1ch` fallback keeps monospace exact and degrades gracefully before the
 *  measurement runs / when styles are absent (tests). */
const COLUMN = "var(--quoll-prose-space, 1ch)";

/** Serialize a column count as `N * COLUMN` (the proportional-font-correct
 *  width of N source columns). */
const columns = (ch: number): string => `${ch} * ${COLUMN}`;

function serialize(c: Col): string {
  // `=== 0` (not `<= 0`): markers is non-negative by construction (see Col),
  // so a hypothetical negative coefficient is NOT silently coerced to a
  // marker-less expression — it would fall through to the `N * var(...)` form
  // and surface as a visibly wrong string in a test rather than vanish.
  if (c.markers === 0) {
    return columns(c.ch);
  }
  if (c.markers === 1) {
    return `${columns(c.ch)} + ${MARKER}`;
  }
  return `${columns(c.ch)} + ${c.markers} * ${MARKER}`;
}

/** Visual column of `pos` within its own line (tabs expanded to tabSize).
 *  This is the model's `col()` meta-function. Exported so the list-hang-indent
 *  provider can reuse it in `blockquotePrefixCols` (per-QuoteMark hidden column
 *  width) without a separate `countColumn` import. */
export function columnAt(state: EditorState, pos: number): number {
  const line = state.doc.lineAt(pos);
  return countColumn(line.text, state.tabSize, pos - line.from);
}

/** The enclosing ListItem of `listItem` (shape: ListItem > Bullet/OrderedList
 *  > ListItem), or null when `listItem` is top-level / the wrapper is
 *  malformed. Requires the parent to carry a `ListMark` so the recursion only
 *  climbs well-formed nesting. */
function enclosingListItem(listItem: SyntaxNode): SyntaxNode | null {
  const parent = listItem.parent?.parent ?? null;
  if (parent === null || parent.name !== "ListItem") {
    return null;
  }
  if (parent.firstChild?.name !== "ListMark") {
    return null;
  }
  return parent;
}

/** The Task content node of a ListItem when it is a RENDERED task (content is a
 *  `Task` node AND its marker geometry resolves), else null. A `Task` whose
 *  marker is invalid (stale tree) is treated as "not a rendered task" so the
 *  re-base / fold decisions stay fail-closed in lock-step with reveal (F7). */
function taskOf(state: EditorState, listItem: SyntaxNode): SyntaxNode | null {
  const content = listItem.firstChild?.nextSibling ?? null;
  if (content === null || content.name !== "Task") {
    return null;
  }
  return resolveTaskMarkerGeometry(state, content) === null ? null : content;
}

/** Width the item's own marker renders as, relative to its ListMark column, or
 *  null when the item is not a renderable list item.
 *
 *  Three-valued by content kind (Codex F-review): a `Task`-named content node
 *  is ALWAYS resolved through the task branch — when its geometry is null
 *  (invalid marker on a stale tree) the item returns null (no hang), mirroring
 *  reveal emitting no checkbox (F7 fail-closed). Only NON-`Task` content falls
 *  to the plain branch. (Treating an invalid-marker Task as plain — the bug the
 *  earlier ordering hid — would desync hang from reveal in the stale-tree case;
 *  unreachable from a fresh parse, but the live editor runs against
 *  one-update-behind trees, so the contract must hold.) */
function ownMarkerWidth(state: EditorState, listItem: SyntaxNode): Col | null {
  const listMark = listItem.firstChild;
  if (listMark === null || listMark.name !== "ListMark") {
    return null;
  }
  const content = listMark.nextSibling;
  if (content === null || content.from === content.to) {
    return null; // empty item / grammar drift
  }
  const markCol = columnAt(state, listMark.from);
  if (content.name === "Task") {
    const geom = resolveTaskMarkerGeometry(state, content);
    if (geom === null) {
      return null; // task-shaped but invalid marker → no hang (F7 fail-closed)
    }
    return { ch: columnAt(state, geom.foldFrom) - markCol, markers: 1 };
  }
  return { ch: columnAt(state, content.from) - markCol, markers: 0 };
}

/** The item's source ListMark column as a `Col` (markers: 0). The model's
 *  `sourceMarkColumn(i)`. */
function sourceMarkColumn(state: EditorState, listItem: SyntaxNode): Col {
  const listMark = listItem.firstChild;
  const col =
    listMark !== null && listMark.name === "ListMark" ? columnAt(state, listMark.from) : 0;
  return { ch: col, markers: 0 };
}

/** Column where the item's MARKER actually renders (recursive across the
 *  ancestor chain). Re-bases ONE NEST_STEP past a task parent's rendered
 *  content column; carries a plain parent's render shift while preserving the
 *  item's source-relative position.
 *
 *  Fail-closed propagation (Codex re-review b): an item that renders NO hang
 *  (`ownMarkerWidth === null` — e.g. an invalid-marker task on a stale tree)
 *  is NOT decorated, so its marker stays at its source column. Returning the
 *  source column for such an item means a descendant re-basing through it
 *  inherits a ZERO shift (not the grandparent's fold shift), keeping the
 *  child's base column consistent with where the undecorated parent really
 *  sits. Reachable only on a one-update-behind tree (a fresh parse never
 *  yields an invalid-marker `Task`), so — like findTaskMarker's own guards —
 *  it carries no parse-based test; it is a structural fail-closed guarantee.
 *
 *  Cost: O(depth) per item (each call walks to the chain root), so a viewport
 *  of nested items is O(items · depth) — for realistic nesting (depth <= ~6)
 *  this is a few hundred cheap ops per rebuild, negligible. If a pathological
 *  deeply-nested doc ever profiles hot, memoize per build with a
 *  Map<number, Col> keyed on ListItem `.from`; not done now (KISS — premature,
 *  and SyntaxNode object identity is not stable across iterate cursors). */
function renderedMarkCol(state: EditorState, listItem: SyntaxNode): Col {
  if (ownMarkerWidth(state, listItem) === null) {
    return sourceMarkColumn(state, listItem); // undecorated → renders at source
  }
  const parent = enclosingListItem(listItem);
  if (parent === null) {
    return sourceMarkColumn(state, listItem);
  }
  if (taskOf(state, parent) !== null) {
    // Re-base one outline step past the (wide-checkbox) task parent's content.
    return add(renderedContentCol(state, parent), NEST_STEP);
  }
  const shift = subtract(renderedMarkCol(state, parent), sourceMarkColumn(state, parent));
  return add(sourceMarkColumn(state, listItem), shift);
}

/** Column where the item's CONTENT renders = renderedMarkCol + ownMarkerWidth.
 *  Only called on items with a valid ownMarkerWidth (the item itself, already
 *  validated, or a task parent whose marker is valid). */
function renderedContentCol(state: EditorState, listItem: SyntaxNode): Col {
  const own = ownMarkerWidth(state, listItem) ?? { ch: 0, markers: 0 };
  return add(renderedMarkCol(state, listItem), own);
}

/** Resolve the `{ indent, pad }` CSS column expressions for one ListItem, or
 *  null when the node is not a recognised non-empty list item (grammar drift /
 *  empty item / task with invalid marker). `indent` is the first-line
 *  text-indent magnitude; `pad` is the continuation hang.
 *
 *  `hiddenPrefixCols` (default 0) is the visual-column width of the blockquote
 *  `> ` prefix that blockquote-reveal HIDES caret-off. Computed by the
 *  provider's `blockquotePrefixCols` and subtracted from both the `indent` and
 *  `pad` column expressions so the hang tracks the reveal. 0 for
 *  non-blockquoted lines and for caret-on (the provider passes 0), leaving the
 *  original physical-column geometry intact. */
export function resolveListItemHang(
  state: EditorState,
  listItem: SyntaxNode,
  hiddenPrefixCols = 0
): { indent: string; pad: string } | null {
  const own = ownMarkerWidth(state, listItem);
  if (own === null) {
    return null;
  }
  // Subtract the blockquote-prefix columns that blockquote-reveal HIDES caret-off
  // (computed by the provider's blockquotePrefixCols). Both the source-relative
  // first-line pull (indent) and the rendered continuation hang (pad) shift left
  // by the same hidden width. 0 for non-blockquoted lines and caret-on (the
  // provider passes 0), leaving the original physical-column geometry intact.
  const shift: Col = { ch: hiddenPrefixCols, markers: 0 };
  const indent = subtract(add(sourceMarkColumn(state, listItem), own), shift);
  const pad = subtract(add(renderedMarkCol(state, listItem), own), shift);
  return { indent: serialize(indent), pad: serialize(pad) };
}
