// Pure caret <-> CodeMirror conversions for the editor-switch handoff.
//
// 0-based {line, character} is the VS Code `Position` convention shared on the
// wire (caret-report / caret-apply). CodeMirror is 1-based for lines and uses
// absolute offsets internally, so these two functions are the single
// translation point. Both are pure (no EditorView, no DOM) so they unit-test
// in the node environment.

import type { EditorState, Text } from "@codemirror/state";
import { clampInt } from "../../shared/clamping.js";

/** 0-based caret position (VS Code `Position` convention). */
export type Caret = { line: number; character: number };

/** Convert the selection's MAIN range head to a 0-based caret. CodeMirror
 *  `Line.number` is 1-based; the wire is 0-based, so subtract one. */
export function selectionToCaret(state: EditorState): Caret {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number - 1, character: head - line.from };
}

/** Character count of the PRIMARY (main) selection — `to - from` in UTF-16
 *  code units, matching `selectionToCaret`'s character semantics. 0 when the
 *  selection is collapsed. Feeds the status bar's `(N selected)` readout via
 *  the caret-report wire; primary selection only (multi-cursor sum is a
 *  follow-up). Pure so it unit-tests in the node environment. */
export function selectionCharCount(state: EditorState): number {
  const main = state.selection.main;
  return main.to - main.from;
}

/** Convert a 0-based caret to a CodeMirror document offset, clamped to the
 *  live document's bounds. Line clamps to [0, lines-1]; character clamps to
 *  [0, lineLength]. The webview re-clamps here because the host's caret was
 *  measured against a possibly-transiently-different document snapshot. */
export function applyCaret(doc: Text, caret: Caret): number {
  const lineNumber = clampInt(caret.line + 1, 1, doc.lines); // CM lines are 1-based
  const line = doc.line(lineNumber);
  const character = clampInt(caret.character, 0, line.length);
  return line.from + character;
}
