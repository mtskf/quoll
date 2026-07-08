// Shared TASK-marker shape primitives — the SINGLE source of truth for "what a
// checkbox marker looks like", both as bytes (`TASK_MARKER_RE`) and as a
// content-less Lezer structure (`isContentlessTaskParagraph`). A zero-runtime-dep
// LEAF: it imports only CodeMirror TYPES, so both `list-geometry.ts` (geometry /
// reveal side) and `task-checkbox-command.ts` (toggle side) can depend on it
// without the import cycle that would form if either owned the predicate (Codex
// finding #4). Keeping ONE predicate is what stops the reveal and the toggle from
// diverging on what counts as a content-less checkbox (Codex finding #3).

import type { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

/** The GFM TaskMarker byte shape — `[ ]`, `[x]`, or `[X]`. */
export const TASK_MARKER_RE = /^\[[ xX]\]$/;

/** True when `node` is a CONTENT-LESS bare task marker — the parser leaves
 *  `- [ ]` as `ListItem > ListMark, Paragraph("[ ]")` with NO `Task`/`TaskMarker`
 *  node. Requires `node` to be:
 *    - a `Paragraph` of EXACTLY 3 bytes matching `TASK_MARKER_RE`,
 *    - whose parent is a `ListItem` whose `firstChild` is a `ListMark`,
 *    - AND that item's FIRST content node (`listMark.nextSibling` at the same
 *      `from`) — so a LATER `[ ]` paragraph in the same item
 *      (`- first\n\n  [ ]`) is NOT treated as a checkbox (Codex finding #3).
 *  Compared by `.from` (SyntaxNode object identity is not stable across cursor
 *  reads). */
export function isContentlessTaskParagraph(state: EditorState, node: SyntaxNode): boolean {
  if (node.name !== "Paragraph" || node.to - node.from !== 3) {
    return false;
  }
  const item = node.parent;
  if (item === null || item.name !== "ListItem") {
    return false;
  }
  const listMark = item.firstChild;
  if (listMark === null || listMark.name !== "ListMark") {
    return false;
  }
  const firstContent = listMark.nextSibling;
  if (firstContent === null || firstContent.from !== node.from) {
    return false;
  }
  return TASK_MARKER_RE.test(state.doc.sliceString(node.from, node.to));
}
