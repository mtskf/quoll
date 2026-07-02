// ArrowUp-into-reveal for the leading frontmatter block. The span is atomic when
// collapsed, so CM's default cursor-up leapfrogs it. This Prec.high ArrowUp
// handler detects a single empty caret on the line directly BELOW a collapsed
// block and reveals it, landing the caret on the closer line (span.to) so the
// user keeps arrow-stepping up through the source. Re-collapse on the way out is
// selection-driven (the reducer); there is nothing above a file-leading
// frontmatter, so only the upward entry exists.
//
// Frontmatter-specific (not the generic block-zone-arrow-keymap) because the
// reveal is STATEFUL (an effect), and frontmatter does not contribute to
// quollBlockReplaceZones, which that keymap reads.

import { type Extension, Prec } from "@codemirror/state";
import { type Command, type EditorView, keymap } from "@codemirror/view";

import { frontmatterBlockField } from "./frontmatter-field.js";
import { revealFrontmatterAt } from "./reveal-state.js";

export const frontmatterRevealUp: Command = (view: EditorView): boolean => {
  const rs = view.state.field(frontmatterBlockField, false);
  if (!rs || rs.kind !== "collapsed") {
    return false;
  }
  const sel = view.state.selection;
  if (sel.ranges.length !== 1 || !sel.main.empty) {
    return false;
  }
  // The line directly below the block starts at span.to + 1 (after the closer's
  // newline). Only reveal when ArrowUp would step from that line into the block.
  if (view.state.doc.lineAt(sel.main.head).from !== rs.span.to + 1) {
    return false;
  }
  return revealFrontmatterAt(view, rs.span.to);
};

/** Prec.high so ArrowUp runs before defaultKeymap's cursorLineUp (which would
 *  atomically skip the collapsed block). Registered in editor.ts. */
export function frontmatterRevealKeymap(): Extension {
  return Prec.high(keymap.of([{ key: "ArrowUp", run: frontmatterRevealUp }]));
}
