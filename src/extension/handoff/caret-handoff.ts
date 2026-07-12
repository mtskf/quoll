// Pure host-side caret clamp for the editor-switch handoff. Mirrors the
// clampLine pattern in handle-context-handoff.ts: the webview is the untrusted
// boundary (the protocol validator already bounded the coordinates), but only
// the host knows the live document's real line count / line lengths, so the
// caret is re-clamped here before it is applied to the TextEditor. Deps are
// injected (lineCount + a line-length getter) so the function is pure and
// unit-tests without a live VS Code TextEditor.

import { clampInt } from "../../shared/clamping.js";

/** 0-based caret position (VS Code `Position` convention). */
export type Caret = { line: number; character: number };

/** Clamp a 0-based caret to a document's bounds. `line` clamps to
 *  [0, lineCount-1] (and to 0 for an empty document); `character` clamps to
 *  [0, length of the clamped line]. `lineLengthAt` returns the character
 *  count of a given 0-based line. */
export function clampCaret(
  caret: Caret,
  lineCount: number,
  lineLengthAt: (line: number) => number
): Caret {
  const maxLine = Math.max(lineCount - 1, 0);
  const line = clampInt(caret.line, 0, maxLine);
  const character = clampInt(caret.character, 0, lineLengthAt(line));
  return { line, character };
}
