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

/** A list-geometry column: `ch·COLUMN + glyph·GLYPH + markers·MARKER`. `ch`
 *  counts whitespace columns (source indentation + trailing space, × the
 *  measured `--quoll-prose-space`); `glyph` counts marker-glyph columns
 *  (`-`/`*`/`+`, digits, `.`/`)`) sized in the inline `GLYPH` blend (a glyph
 *  renders wider than a space); `markers` counts task checkboxes. `ch`/`glyph`
 *  may be negative in intermediate render-shift arithmetic; `markers` is >= 0
 *  for every value that reaches serialize() — renderShift only subtracts the
 *  markers:0 sourceMarkColumn, so a marker term added by a task ancestor is
 *  never subtracted away. The final serialized INDENT/PAD are non-negative. */
type Col = { ch: number; glyph: number; markers: number };

const add = (a: Col, b: Col): Col => ({
  ch: a.ch + b.ch,
  glyph: a.glyph + b.glyph,
  markers: a.markers + b.markers,
});
const subtract = (a: Col, b: Col): Col => ({
  ch: a.ch - b.ch,
  glyph: a.glyph - b.glyph,
  markers: a.markers - b.markers,
});

/** One outline step added when a child is re-based across a TASK parent's fold.
 *  PR1 placed task-nested children FLUSH at the parent content column (Codex
 *  F2); user dogfooding (2026-06-21) found that flush reads as un-nested under
 *  the task's WIDE checkbox widget (var(--quoll-task-marker-width)) — the
 *  child marker's left edge aligned with the parent's text. Stepping one
 *  NEST_STEP (2 source cols) right makes the nesting visible. Plain parents
 *  (thin `-` marker) keep flush — the source indent already shows nesting.
 *  Value adjustable; pinned by the hang tests. */
const NEST_STEP: Col = { ch: 2, glyph: 0, markers: 0 };

/** One outline step added when a bullet item nests directly under a PLAIN
 *  bullet (outside a blockquote). Doubles the rendered per-level indent: the
 *  literal source-space glyphs already contribute ~2 cols (~7px) per level; this
 *  fixed 2-col step lands only on renderedMarkCol (→ the continuation `pad` and,
 *  via `pad − indent`, the first-line offset), summing to ~14px/level — the
 *  Notion/Obsidian feel. Keyed on the PARENT being a plain bullet (NOT the
 *  child's kind) so mixed plain/task siblings under one parent stay aligned; the
 *  child may be a plain bullet or a bullet task. Kept SEPARATE from NEST_STEP
 *  (task-fold re-basing) so the two can be tuned independently; same 2-col value
 *  today. The fixed step doubles exactly for the CommonMark-canonical 2-space
 *  indent (what Quoll's list editing emits); a 4-space source renders 1.5× and a
 *  tab snaps to its grid — an intentional uniform rhythm, same shape as NEST_STEP. */
const BULLET_NEST_STEP: Col = { ch: 2, glyph: 0, markers: 0 };

/** The CSS token for one source-indentation column. A list line renders in the
 *  proportional prose font (`var(--vscode-font-family)`), where a source
 *  character is NARROWER than `1ch` (= the `0` glyph). Using bare `ch` made
 *  `text-indent` over-pull, so wrapped continuation lines hung deeper than the
 *  item's first-line text (the nested-bullet over-indent bug). `--quoll-prose-space`
 *  is the measured space advance of the prose font (set by prose-space-metric.ts);
 *  the `1ch` fallback keeps monospace exact and degrades gracefully before the
 *  measurement runs / when styles are absent (tests). */
const COLUMN = "var(--quoll-prose-space, 1ch)";

/** The CSS token for one MARKER-GLYPH column (`-`/`*`/`+`, a digit, `.`/`)`). A
 *  marker glyph renders WIDER than a space in the proportional prose font (`-`
 *  ≈ 1.7× a space; digits ≈ a `0`), so the glyph run is sized at the midpoint
 *  between the `0` advance (`1ch`) and a space rather than --quoll-prose-space
 *  (which under-pulled and left wrapped lines hanging a few px left of the
 *  first-line text; measured in the browser harness 2026-07-03).
 *
 *  Emitted INLINE (not via a custom property): a `var(--quoll-prose-space)`
 *  inside a `:root`/element custom-property value is substituted at the
 *  declaring element, baking to the static `1ch` fallback instead of the
 *  measured advance proseSpaceMetric publishes on `.cm-editor`. Inlining it in
 *  the per-line decoration style resolves `var(--quoll-prose-space)` and `1ch`
 *  against `.cm-line` (measured / prose font) at the use site.
 *
 *  Font-ADAPTIVE, not font-proof — glyph advance ratios differ per font (the
 *  `1.` +2px outlier shows the limit); it degrades gracefully (monospace → the
 *  `1ch` fallback == a space == `0`, exact). */
const GLYPH = "calc((1ch + var(--quoll-prose-space, 1ch)) / 2)";

/** Serialize a column count as `N * COLUMN` (the proportional-font-correct
 *  width of N whitespace columns). */
const columns = (ch: number): string => `${ch} * ${COLUMN}`;

/** Serialize a marker-glyph count as `N * GLYPH` (the inline glyph blend). */
const glyphs = (g: number): string => `${g} * ${GLYPH}`;

function serialize(c: Col): string {
  // Always emit the `ch` term (preserves the `0 * …` task form pinned by the
  // suite). `markers` is non-negative by construction (see Col); a glyph term
  // is emitted only when non-zero so task items (glyph:0) stay byte-identical.
  let out = columns(c.ch);
  if (c.glyph !== 0) {
    out += ` + ${glyphs(c.glyph)}`;
  }
  if (c.markers === 1) {
    out += ` + ${MARKER}`;
  } else if (c.markers !== 0) {
    out += ` + ${c.markers} * ${MARKER}`;
  }
  return out;
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

/** True when `listItem`'s wrapping list is a `BulletList` (a bullet item — plain
 *  OR a task). Ordered items (OrderedList wrapper) are excluded. */
function isBulletItem(listItem: SyntaxNode): boolean {
  return listItem.parent?.name === "BulletList";
}

/** True when any ANCESTOR of `node` is a `Blockquote`. Blockquoted lists carry
 *  their own hidden-prefix geometry (list-hang-indent's blockquotePrefixCols);
 *  we freeze their nesting width this PR (a product choice — keep quotes' lists
 *  at the pre-fix step), so they are excluded from BULLET_NEST_STEP. Walks
 *  PARENTS only, so an item that CONTAINS a blockquote (`- > quote`) — where the
 *  Blockquote is a child — is unaffected. */
function hasBlockquoteAncestor(node: SyntaxNode): boolean {
  for (let p = node.parent; p !== null; p = p.parent) {
    if (p.name === "Blockquote") {
      return true;
    }
  }
  return false;
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
    // Split the VISIBLE marker prefix the same way the plain branch does: the
    // glyph run up to the fold point (`N.`/`N)` for an ordered task) renders
    // wider than a space, so it is sized in the GLYPH blend; the trailing
    // whitespace up to `foldFrom` stays in prose-space. Clamped to `foldFrom`
    // (`min(listMark.to, foldFrom)`) so a BULLET task — foldFrom == listMarkFrom,
    // the whole `- ` folds into the checkbox — keeps glyph:0 / ch:0, byte-identical
    // with the pre-split all-prose-space behaviour.
    const glyphToCol = columnAt(state, Math.min(listMark.to, geom.foldFrom));
    return {
      ch: columnAt(state, geom.foldFrom) - glyphToCol,
      glyph: glyphToCol - markCol,
      markers: 1,
    };
  }
  // Split the plain marker prefix: the ListMark glyph run (`-`/`*`/`+`, `N.`,
  // `N)`) renders wider than a space, so it is sized in the GLYPH blend; the
  // trailing whitespace up to the content stays in --quoll-prose-space.
  const listMarkTo = columnAt(state, listMark.to);
  return {
    ch: columnAt(state, content.from) - listMarkTo,
    glyph: listMarkTo - markCol,
    markers: 0,
  };
}

/** True iff this ListItem renders a hang — i.e. `resolveListItemHang` (and the
 *  `.quoll-list-hang` line decoration) would be NON-null for it. Structural
 *  eligibility only (`ownMarkerWidth !== null`: valid ListMark + non-empty
 *  content + valid Task marker), WITHOUT `resolveListItemHang`'s O(depth)
 *  `renderedMarkCol` ancestor-chain walk. In lock-step with `resolveListItemHang`
 *  by construction — that resolver's SOLE null path is `ownMarkerWidth === null`.
 *  Lets a whole-document caller (the fold-gutter marker tag) gate in step with the
 *  hang decoration without paying the geometry cost it does not consume. */
export function isRenderableListItem(state: EditorState, listItem: SyntaxNode): boolean {
  return ownMarkerWidth(state, listItem) !== null;
}

/** The item's source ListMark column as a `Col` (markers: 0). The model's
 *  `sourceMarkColumn(i)`. */
function sourceMarkColumn(state: EditorState, listItem: SyntaxNode): Col {
  const listMark = listItem.firstChild;
  const col =
    listMark !== null && listMark.name === "ListMark" ? columnAt(state, listMark.from) : 0;
  return { ch: col, glyph: 0, markers: 0 };
}

/** Column where the item's MARKER actually renders (recursive across the
 *  ancestor chain). Re-bases ONE NEST_STEP past a task parent's rendered
 *  content column; carries a plain parent's render shift while preserving the
 *  item's source-relative position; and, for a bullet nested under a PLAIN
 *  bullet (non-blockquote), adds one BULLET_NEST_STEP so each plain-bullet level
 *  renders ~2× its raw source-space indent (parent-keyed — see BULLET_NEST_STEP).
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
  const base = add(sourceMarkColumn(state, listItem), shift);
  // Bullet nesting under a PLAIN bullet (this branch already guarantees the
  // parent is non-task): add one BULLET_NEST_STEP so each level renders ~2× the
  // raw source-space indent. Both parent and child must be BulletList items —
  // this excludes ordered parents/children (they keep their geometry) while
  // still stepping a bullet task child (parent-keyed → sibling alignment).
  // Skipped inside a blockquote (frozen this PR — see hasBlockquoteAncestor).
  if (!hasBlockquoteAncestor(listItem) && isBulletItem(parent) && isBulletItem(listItem)) {
    return add(base, BULLET_NEST_STEP);
  }
  return base;
}

/** Column where the item's CONTENT renders = renderedMarkCol + ownMarkerWidth.
 *  Only called on items with a valid ownMarkerWidth (the item itself, already
 *  validated, or a task parent whose marker is valid). */
function renderedContentCol(state: EditorState, listItem: SyntaxNode): Col {
  const own = ownMarkerWidth(state, listItem) ?? { ch: 0, glyph: 0, markers: 0 };
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
  const shift: Col = { ch: hiddenPrefixCols, glyph: 0, markers: 0 };
  const indent = subtract(add(sourceMarkColumn(state, listItem), own), shift);
  const pad = subtract(add(renderedMarkCol(state, listItem), own), shift);
  return { indent: serialize(indent), pad: serialize(pad) };
}
