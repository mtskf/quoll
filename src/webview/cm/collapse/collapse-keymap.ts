// Keyboard path for the "Show more" / "Show less" bars (fenced code, blockquote). The bars'
// buttons are not Tab-reachable in the editable editor — Tab belongs to the list-indent
// keymap by design (list-indent-keymap.ts header) — so the toggle rides the FOLD keys
// instead: the same gesture already means "fold / unfold the thing at the caret".
//
//   Ctrl-Shift-[ (Cmd-Alt-[ on macOS) → collapse the expanded long block at the caret
//   Ctrl-Shift-] (Cmd-Alt-] on macOS) → expand the collapsed long block at the caret
//
// Each command returns false when there is more than one caret, or the caret is not in a
// long block of the other state, so the key falls through to quollFoldKeymap's foldCode /
// unfoldCode. With a single caret the two do not compete:
// foldCode folds only a range that STARTS on the caret line, and no line of a top-level fence
// or quote starts one (both are subtracted from folding in cm/markdown.ts). Prec.high makes
// the order explicit rather than a side effect of extension order in editor.ts.
//
// Read-only: the content DOM is not a focus target, so these keys never reach it there.
// Tab lands on the scroller instead (the read-only tab stop, editor.ts), PageDown scrolls
// to the block, and the next Tab reaches the bar's <button> natively (list-indent declines
// Tab when read-only); Enter toggles it. The shared renderer then hands focus to the
// replacement bar, or to the scroller when that bar is not on screen.

import { Prec } from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";
import { blockquoteCollapseField } from "../decorations/blockquote-collapse.js";
import { blockquoteCollapseTarget } from "../decorations/blockquote-collapse-state.js";
import { fencedCodeCollapseField } from "../fenced-code/fenced-code-collapse.js";
import { fencedCollapseTarget } from "../fenced-code/fenced-code-collapse-state.js";
import { collapseAtCaretCommand } from "./line-collapse-field.js";

function eitherClient(expand: boolean): Command {
  const fenced = collapseAtCaretCommand(fencedCodeCollapseField, fencedCollapseTarget, expand);
  const quote = collapseAtCaretCommand(blockquoteCollapseField, blockquoteCollapseTarget, expand);
  // Single caret only: foldCode / unfoldCode act on every selected line, so with several
  // carets the key keeps that meaning. Top-level blocks never overlap, so at most one
  // client owns the caret.
  return (view) => view.state.selection.ranges.length === 1 && (fenced(view) || quote(view));
}

export const collapseLongBlockAtCaret: Command = eitherClient(false);
export const expandLongBlockAtCaret: Command = eitherClient(true);

export const quollCollapseKeymap = Prec.high(
  keymap.of([
    { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[", run: collapseLongBlockAtCaret },
    { key: "Ctrl-Shift-]", mac: "Cmd-Alt-]", run: expandLongBlockAtCaret },
  ])
);
