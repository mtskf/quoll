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
 *  reads).
 *
 *  DELIBERATELY EXCLUDED — a CONTINUATION-BODY task (`- [ ]\n  child`): the `[ ]`
 *  marker on line 1 with the body on an indented continuation line parses as a
 *  SINGLE `Paragraph("[ ]\n  child")` (> 3 bytes, so the length guard above
 *  rejects it) — again NO `Task` node — so it renders as a plain bullet + literal
 *  `[ ]`. This is INTENTIONAL, not a gap: the authoritative GFM renderer
 *  (GitHub's cmark-gfm task-list extension) requires a space/tab *on the same
 *  line* after the marker (`("[ ]"|"[x]")` followed by `spacechar+`, where
 *  `spacechar = [ \t\v\f]` EXCLUDES the newline), so GitHub also renders
 *  `- [ ]\n  child` as literal `[ ] child` with no checkbox (verified against
 *  cmark-gfm via babelmark3, and matching `@lezer/markdown`, which emits no
 *  `Task` here either). Do NOT widen this predicate to accept a first-content
 *  Paragraph that merely STARTS with `[ ]`: that would diverge from GitHub, and
 *  special-casing against the parser is exactly the fragility we avoid. The
 *  content-less `- [ ]` above is a narrow WYSIWYG exception (the transient
 *  just-typed-marker state, PR #120) — it does NOT generalise to bodies. */
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
