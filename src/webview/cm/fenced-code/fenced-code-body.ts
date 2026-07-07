// Single source of truth for a FencedCode node's fence/body LANDMARKS — the
// 1-based open/close fence line numbers and the BODY line span (the lines
// strictly between the opening ```lang fence and the closing ``` fence). Every
// surface that depends on the Lezer-node shape of a fenced block reads from
// here so the `getChildren("CodeMark")` walk lives in exactly one place:
//   - block-style.ts (panel edges) reads the full landmark set;
//   - the copy button (fenced-code-copy-button.ts) and the collapse threshold
//     (fenced-code-collapse.ts) read the body span via fencedCodeBodyLineSpan,
//     a thin projection of the same result.
// Keeping the CodeMark walk single-sourced means "what counts as the body" and
// "where the close fence is" cannot drift across those surfaces.

import type { syntaxTree } from "@codemirror/language";
import type { EditorSelection, Text } from "@codemirror/state";

import { intersectsAnySelection } from "../decorations/shared.js";

// `@lezer/common` is a direct dep as of PR #66 (for the lint incremental
// parser's `TreeFragment`); derive SyntaxNode from syntaxTree's return type
// rather than importing it to keep the direct-dep surface narrow — the same
// strategy as decorations/types.ts and fenced-code-copy-button.ts.
type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

/** Fence + body geometry of a FencedCode node, all derived from ONE
 *  `getChildren("CodeMark")` pass. Line numbers are 1-based (CodeMirror
 *  `doc.line` convention). `bodyStartLine` / `bodyEndLine` are always set
 *  together — both null exactly when the block has no body. */
export type FencedCodeFenceLandmarks = {
  /** 1-based line of the opening ```lang fence. */
  openFenceLine: number;
  /** 1-based line of the closing ``` fence, or null for an unclosed block
   *  (a single CodeMark — the open fence runs to EOF). */
  closeFenceLine: number | null;
  /** First/last BODY line (between the fences), or null when the block has no
   *  body (e.g. ```` ```\n``` ````). */
  bodyStartLine: number | null;
  bodyEndLine: number | null;
};

/** All fence/body landmarks of `node` from a single CodeMark walk. CodeMark
 *  children are the opening and (if closed) closing fences: two marks → closed
 *  (the last is the close fence, body ends the line before it); one mark →
 *  unclosed at EOF (body runs to the node's last content line — `node.to` is
 *  half-open so `node.to - 1` is the last content offset). Deriving the close
 *  line from the LAST CodeMark (NOT `node.to - 1`) keeps a Lezer `node.to` that
 *  overshoots a trailing line from drifting the close landmark
 *  (quoll-lezer-table-to-overshoots-trailing-line). */
export function fencedCodeFenceLandmarks(doc: Text, node: SyntaxNode): FencedCodeFenceLandmarks {
  const openLine = doc.lineAt(node.from);
  const marks = node.getChildren("CodeMark");
  const closed = marks.length >= 2;
  const closeFenceLine = closed ? doc.lineAt(marks[marks.length - 1].from).number : null;
  const bodyEndLine =
    closeFenceLine !== null
      ? closeFenceLine - 1
      : doc.lineAt(Math.min(node.to, doc.length) - 1).number;
  const bodyStartLine = openLine.number + 1;
  const hasBody = bodyStartLine <= bodyEndLine;
  return {
    openFenceLine: openLine.number,
    closeFenceLine,
    bodyStartLine: hasBody ? bodyStartLine : null,
    bodyEndLine: hasBody ? bodyEndLine : null,
  };
}

/** 1-based line numbers of the first and last BODY line of `node`, or `null`
 *  when the block has no body. Thin projection of {@link fencedCodeFenceLandmarks}
 *  so the body-only consumers (copy button, collapse threshold) share its single
 *  CodeMark walk. */
export function fencedCodeBodyLineSpan(
  doc: Text,
  node: SyntaxNode
): { startLine: number; endLine: number } | null {
  const { bodyStartLine, bodyEndLine } = fencedCodeFenceLandmarks(doc, node);
  if (bodyStartLine === null || bodyEndLine === null) {
    return null;
  }
  return { startLine: bodyStartLine, endLine: bodyEndLine };
}

/** True when any selection range falls anywhere within `node`'s FULL line span —
 *  the BLOCK-SCOPED fence-reveal predicate. A caret in the code BODY reveals BOTH
 *  fences (so the ```lang tag + closing ``` can be edited in place), where the old
 *  per-fence-line rule left them concealed. THE single definition of fenced-block
 *  reveal: fenced-code-reveal.ts (fence MARKS) and block-style.ts (fence-ROW
 *  collapse + blockquote edge migration) BOTH call this, so the two concealment
 *  surfaces can never disagree about which fences show. For a CLOSED block the
 *  span END comes from the closing fence's landmark line (derived from the LAST
 *  CodeMark, NOT node.to), so a Lezer node.to overshoot cannot drift it
 *  (quoll-lezer-table-to-overshoots-trailing-line). For an UNCLOSED block the
 *  fall-back `bodyEndLine` is node.to-derived — the SAME accepted contract
 *  `fencedCodeFenceLandmarks` already uses everywhere (the block-style panel span
 *  included), so this adds no new overshoot surface. Kept in this geometry module
 *  (rather than a separate visibility module) for cohesion — it is a thin function
 *  of the node's line span; a dedicated policy module is deferred until a second
 *  reveal-policy consumer appears (Codex #7). */
export function fencedCodeBlockRevealed(
  doc: Text,
  selection: EditorSelection,
  node: SyntaxNode
): boolean {
  const { openFenceLine, closeFenceLine, bodyEndLine } = fencedCodeFenceLandmarks(doc, node);
  const lastLine = closeFenceLine ?? bodyEndLine ?? openFenceLine;
  return intersectsAnySelection(selection, doc.line(openFenceLine).from, doc.line(lastLine).to);
}
