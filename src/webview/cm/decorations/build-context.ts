// Snapshot an EditorView into the pure BuildContext consumed by the inline
// decoration providers + block-widget builders. Byte-identical copies of this
// lived in block-style / heading-rhythm / fenced-code-copy-button /
// list-hang-indent; this is the single definition. Kept out of types.ts so that
// module stays type-only (see its header).

import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import type { BuildContext } from "./types.js";

/** Build a `BuildContext` snapshot from a live view (state / selection /
 *  visibleRanges + the shared syntax tree). */
export function toCtx(view: EditorView): BuildContext {
  return {
    state: view.state,
    selection: view.state.selection,
    visibleRanges: view.visibleRanges,
    tree: syntaxTree(view.state),
  };
}
