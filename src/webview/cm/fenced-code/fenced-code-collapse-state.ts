// Collapse-state primitives shared by the StateField (fenced-code-collapse.ts)
// and the toggle widget (fenced-code-collapse-widget.ts): the expand/collapse
// StateEffect, the per-block geometry, and the toggle command. Kept in its own
// module so the field and the widget both depend on it WITHOUT a field↔widget
// import cycle (parity with frontmatter/reveal-state.ts).

import { syntaxTree } from "@codemirror/language";
import { type EditorState, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { COLLAPSE_THRESHOLD, parkSelectionOutsideConceal } from "../collapse/collapse-shared.js";
import { type CollapseTarget, toggleCollapse } from "../collapse/line-collapse-field.js";
import { fencedCodeFenceLandmarks } from "./fenced-code-body.js";

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

// Both moved to the shared collapse layer; re-exported so no importer changes.
export { COLLAPSE_THRESHOLD, parkSelectionOutsideConceal };

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
  /** True when the block has a closing fence; false for an unclosed block (runs to
   *  EOF). The bounded field uses this to pick the liveness extent — an unclosed
   *  block owns everything to doc end, so its record's blockTo is doc.length. */
  closed: boolean;
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
  return {
    key,
    concealFrom,
    concealTo,
    collapseTo,
    safeCaret,
    lastBodyLine: bodyEndLine,
    closed: closeFenceLine !== null,
  };
}

/** Resolve the collapsible FencedCode whose open line.from === `key`, with FRESH
 *  geometry (no stale closure). The toggle command now resolves its block through the
 *  shared `findCollapseBlockAt` (../collapse/line-collapse-field.ts), which uses the same
 *  walk; this fenced-typed lookup stays as the unit-tested pin of that keying rule.
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

/** The fenced client's find/toggle target for the shared collapse reducer. Defined here
 *  (no widget import, no frontier gate) so the widget can import the toggle from this
 *  module without a cycle. */
export const fencedCollapseTarget: CollapseTarget<null> = {
  nodeName: "FencedCode",
  blockFor: (state, node) => {
    const g = fencedBlockGeometry(state, node);
    if (g === null) {
      return null;
    }
    return {
      key: g.key,
      concealFrom: g.concealFrom,
      concealTo: g.concealTo,
      collapseTo: g.collapseTo,
      // An unclosed block owns everything to doc end.
      blockTo: g.closed ? g.collapseTo : state.doc.length,
      hiddenCount:
        state.doc.lineAt(g.concealTo).number - state.doc.lineAt(g.concealFrom).number + 1,
      safeCaret: g.safeCaret,
      extra: null,
    };
  },
  effect: setFencedCollapseEffect,
};

/** Toggle a block's expanded state; collapsing also parks every selection head inside the
 *  soon-concealed region (the closing fence included) in the SAME transaction. */
export function toggleFencedCollapse(view: EditorView, key: number, expand: boolean): void {
  toggleCollapse(view, fencedCollapseTarget, key, expand);
}
