// Collapse-state primitives shared by the StateField (fenced-code-collapse.ts)
// and the toggle widget (fenced-code-collapse-widget.ts): the expand/collapse
// StateEffect, the per-block geometry, and the toggle command. Kept in its own
// module so the field and the widget both depend on it WITHOUT a field↔widget
// import cycle (parity with frontmatter/reveal-state.ts).

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { fencedCodeFenceLandmarks } from "./fenced-code-body.js";

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

/** Bodies with strictly MORE than this many lines collapse; 10 or fewer render
 *  unchanged. */
export const COLLAPSE_THRESHOLD = 10;

/** Toggle a block's expanded state. `key` is the open-fence line.from offset; it
 *  is mapped through document changes so a held effect survives a same-tick edit. */
export const setFencedCollapseEffect = StateEffect.define<{ key: number; expanded: boolean }>({
  map: (value, changes) => ({ key: changes.mapPos(value.key, 1), expanded: value.expanded }),
});

export interface FencedBlockGeometry {
  /** Open-fence line.from offset — the stable block key. */
  key: number;
  /** First doc offset of the would-be-concealed region (start of body line 11). */
  concealFrom: number;
  /** Last doc offset of the concealed BODY region (end of the last body line). The
   *  Show-less anchor + hidden-line-count boundary — always the body/close-fence
   *  seam, never the closing fence itself. */
  concealTo: number;
  /** Upper bound of the COLLAPSED conceal range: end of the closing fence line, so
   *  the collapsed block-replace hides the closing fence too AND a caret parked ON
   *  the closing fence counts as inside the concealed region → auto-expands (never
   *  leaving a revealed rounded `.quoll-fenced-code-close` footer under the already-
   *  rounded Show-more bar — the double-round bug). Equals `concealTo` for an
   *  unclosed block (no closing fence to conceal). */
  collapseTo: number;
  /** A caret position guaranteed OUTSIDE [concealFrom, collapseTo] (end of the
   *  10th visible body line) — where the caret is parked on collapse. */
  safeCaret: number;
  /** Document line number (1-based) of the last body line — the Show-less anchor. */
  lastBodyLine: number;
}

/** Geometry for `node` iff it is a TOP-LEVEL FencedCode whose body exceeds the
 *  threshold; `null` otherwise. Top-level gate matches fenced-code-copy-button.ts. */
export function fencedBlockGeometry(
  state: EditorState,
  node: SyntaxNode
): FencedBlockGeometry | null {
  const parent = node.parent;
  if (parent === null || parent.name !== "Document") {
    return null;
  }
  const doc = state.doc;
  // Single CodeMark walk gives the body span AND the closing fence line together,
  // so the collapsed conceal range can extend over the closing fence.
  const { closeFenceLine, bodyStartLine, bodyEndLine } = fencedCodeFenceLandmarks(doc, node);
  if (bodyStartLine === null || bodyEndLine === null) {
    return null;
  }
  const bodyLineCount = bodyEndLine - bodyStartLine + 1;
  if (bodyLineCount <= COLLAPSE_THRESHOLD) {
    return null;
  }
  const key = doc.lineAt(node.from).from;
  // First concealed body line = the (THRESHOLD+1)-th body line.
  const firstHiddenLine = bodyStartLine + COLLAPSE_THRESHOLD;
  const concealFrom = doc.line(firstHiddenLine).from;
  const concealTo = doc.line(bodyEndLine).to;
  // Extend the COLLAPSED conceal range over the closing fence (if any) so a caret
  // on it auto-expands instead of revealing a second rounded footer under the bar.
  const collapseTo = closeFenceLine !== null ? doc.line(closeFenceLine).to : concealTo;
  const safeCaret = doc.line(firstHiddenLine - 1).to; // end of the 10th visible body line
  return { key, concealFrom, concealTo, collapseTo, safeCaret, lastBodyLine: bodyEndLine };
}

/** Resolve the collapsible FencedCode whose open line.from === `key`. Used by the
 *  toggle command to recompute FRESH geometry at click time (no stale closure).
 *
 *  DD1: keyed by `doc.lineAt(node.from).from`, matched via `tree.iterate` — NOT
 *  `resolveInner(key, 1)`. For an INDENTED fence (`  ```js`) the key is the line
 *  start, which is BEFORE `node.from` (the fence mark), so `resolveInner(key, 1)`
 *  resolves to the leading whitespace outside the FencedCode and never climbs to
 *  it. Iterating and matching the same key the build uses makes indented and
 *  unindented fences behave identically. Click-time only (a user gesture), so a
 *  full iterate is cheap. */
export function findCollapsibleFencedBlockAt(
  state: EditorState,
  key: number
): FencedBlockGeometry | null {
  if (key < 0 || key > state.doc.length) {
    return null;
  }
  let result: FencedBlockGeometry | null = null;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (result !== null) {
        return false; // already found — stop walking
      }
      if (node.name === "FencedCode") {
        if (state.doc.lineAt(node.from).from === key) {
          result = fencedBlockGeometry(state, node.node);
        }
        return false; // never descend into a code body
      }
      // Top-level fences are Document children; nothing else can contain one.
      return node.name === "Document" ? undefined : false;
    },
  });
  return result;
}

/** Move EVERY selection range whose head lands in `[concealFrom, concealTo]` out to
 *  a cursor at `safeCaret`; ranges whose head is outside are kept verbatim. Returns
 *  `null` when no head is inside (no selection change needed).
 *
 *  DD4 symmetry: the build's auto-expand checks ALL range heads, so parking only
 *  `selection.main.head` would let a SECONDARY caret inside the region re-trigger
 *  auto-expand on the very next rebuild → an infinite collapse↔expand loop. Parking
 *  every inside-head closes that loop.
 *
 *  Two inside-heads parked onto the SAME `safeCaret` merge inside
 *  `EditorSelection.create` → `normalized`, which adjusts `mainIndex` with
 *  `if (i <= mainIndex) mainIndex--` on every merge at/before the main (verified
 *  against @codemirror/state 6.6.0 `EditorSelection.normalized` — the merge
 *  decrements `mainIndex` for ANY merge index `<= mainIndex`, not only `===`), so
 *  the result stays in range even when an outside main sits at a higher index than
 *  two merged inside cursors. NO out-of-bounds. Pinned by the 3-cursor test. */
export function parkSelectionOutsideConceal(
  selection: EditorSelection,
  concealFrom: number,
  concealTo: number,
  safeCaret: number
): EditorSelection | null {
  let changed = false;
  const ranges = selection.ranges.map((r) => {
    if (r.head >= concealFrom && r.head <= concealTo) {
      changed = true;
      return EditorSelection.cursor(safeCaret);
    }
    return r;
  });
  return changed ? EditorSelection.create(ranges, selection.mainIndex) : null;
}

/** Toggle the block keyed by `key`. Expand → just dispatch the effect. Collapse →
 *  dispatch the effect AND park every selection head that sits inside the
 *  soon-concealed region (DD4) in the SAME transaction, so the build's auto-expand
 *  does not immediately re-open it. */
export function toggleFencedCollapse(view: EditorView, key: number, expand: boolean): void {
  const effects = setFencedCollapseEffect.of({ key, expanded: expand });
  if (expand) {
    view.dispatch({ effects });
    return;
  }
  const block = findCollapsibleFencedBlockAt(view.state, key);
  const parked =
    block === null
      ? null
      : parkSelectionOutsideConceal(
          view.state.selection,
          block.concealFrom,
          // Park heads on the closing fence too (collapseTo, not concealTo): otherwise
          // collapsing with the caret on the ``` would auto-expand right back.
          block.collapseTo,
          block.safeCaret
        );
  view.dispatch(parked !== null ? { effects, selection: parked } : { effects });
}
