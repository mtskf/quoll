// Collapse-state primitives for the blockquote "Show more" bar, shared by the StateField
// (blockquote-collapse.ts) and the toggle widget (blockquote-collapse-widget.ts): the
// expand/collapse StateEffect, the per-quote geometry, the find/toggle target and the
// toggle command. Kept in its own module so the field and the widget both depend on it
// WITHOUT a field↔widget import cycle (parity with fenced-code-collapse-state.ts).

import { type EditorState, StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { COLLAPSE_THRESHOLD } from "../collapse/collapse-shared.js";
import { type CollapseTarget, toggleCollapse } from "../collapse/line-collapse-field.js";
import { type CalloutType, calloutTypeForOutermost } from "./callout.js";

type SyntaxNode = Parameters<typeof calloutTypeForOutermost>[1];

/** Toggle a quote's expanded state. `key` is the first line's `line.from`; it is mapped
 *  through document changes so a held effect survives a same-tick edit. */
export const setBlockquoteCollapseEffect = StateEffect.define<{ key: number; expanded: boolean }>({
  map: (value, changes) => ({ key: changes.mapPos(value.key, 1), expanded: value.expanded }),
});

export interface BlockquoteBlockGeometry {
  /** First line's `line.from` — the stable block key. */
  key: number;
  /** Start of line THRESHOLD+1: first concealed offset. */
  concealFrom: number;
  /** End of the last line: anchor of the expanded "Show less" widget. */
  concealTo: number;
  /** End of the last visible line — where heads are parked on collapse. */
  safeCaret: number;
  hiddenCount: number;
  /** The callout type of the outermost quote, or null for a plain quote. */
  calloutType: CalloutType | null;
}

/** Geometry for `node` iff it is a TOP-LEVEL Blockquote of more than COLLAPSE_THRESHOLD
 *  source lines; null otherwise. Every line of the node counts (nested `> >`, lazy
 *  continuation, a callout's marker row). */
export function blockquoteBlockGeometry(
  state: EditorState,
  node: SyntaxNode
): BlockquoteBlockGeometry | null {
  const parent = node.parent;
  if (node.name !== "Blockquote" || parent === null || parent.name !== "Document") {
    return null;
  }
  const doc = state.doc;
  const firstLine = doc.lineAt(node.from).number;
  // node.to is half-open; node.to - 1 is the last content byte (block-style.ts parity).
  const lastLine = doc.lineAt(Math.max(node.from, node.to - 1)).number;
  const lineCount = lastLine - firstLine + 1;
  if (lineCount <= COLLAPSE_THRESHOLD) {
    return null;
  }
  const firstHidden = firstLine + COLLAPSE_THRESHOLD;
  return {
    key: doc.line(firstLine).from,
    concealFrom: doc.line(firstHidden).from,
    concealTo: doc.line(lastLine).to,
    safeCaret: doc.line(firstHidden - 1).to,
    hiddenCount: lineCount - COLLAPSE_THRESHOLD,
    calloutType: calloutTypeForOutermost(doc, node),
  };
}

export const blockquoteCollapseTarget: CollapseTarget<CalloutType | null> = {
  nodeName: "Blockquote",
  blockFor: (state, node) => {
    const g = blockquoteBlockGeometry(state, node);
    if (g === null) {
      return null;
    }
    return {
      key: g.key,
      concealFrom: g.concealFrom,
      concealTo: g.concealTo,
      collapseTo: g.concealTo, // no closing delimiter to swallow
      blockTo: g.concealTo,
      hiddenCount: g.hiddenCount,
      safeCaret: g.safeCaret,
      extra: g.calloutType,
    };
  },
  effect: setBlockquoteCollapseEffect,
};

/** Toggle a quote's expanded state; collapsing also parks every selection head inside the
 *  soon-concealed region in the SAME transaction. */
export function toggleBlockquoteCollapse(view: EditorView, key: number, expand: boolean): void {
  toggleCollapse(view, blockquoteCollapseTarget, key, expand);
}
