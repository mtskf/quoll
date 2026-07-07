// Enter on an unclosed ```-fence OPENER auto-inserts a matching closing fence and
// lands the caret on the empty body line between the two — the Notion/Obsidian
// "close the code block for me" ergonomic. Without it, typing a fence opener
// mid-document opens an UNCLOSED block that reflows every following line into
// code until EOF (correct CommonMark, but a hazard while editing) and the user
// has to type the closer by hand.
//
// TRIGGER (all must hold): the caret's line is the OPENING fence line of a
// FencedCode node that is UNCLOSED (a single CodeMark child — the open fence runs
// to EOF). The enclosing FencedCode is resolved from the caret via the syntax
// tree, so the guards fall out of the node shape rather than a hand-rolled scan:
//   - inline `` `code` `` never triggers (InlineCode has no FencedCode ancestor);
//   - a caret already INSIDE the block's body / on its closer never triggers (its
//     line is not the opener line);
//   - an already-CLOSED opener never triggers (two CodeMark children — a closer
//     already follows), so editing a closed fence keeps Enter's default newline.
// In every non-trigger case the command returns false so CodeMirror falls through
// to the default Enter (insertNewlineAndIndent) — unlike the Tab keymap, the
// default Enter is wanted here.
//
// The closer reuses the opener's OWN fence run (```/````/~~~ — the CodeMark
// slice), and the inserted body + closer lines carry a CONTINUATION prefix
// derived from the opener's leading indent / blockquote-or-list markers so the
// closer parses in the SAME block context (a `> ` fence closes with `> ```; a
// list-indented fence closes at the content column). It is ONE ordinary CM
// transaction, so it rides the normal updateListener → edit-sync → host
// write-lock pipeline and round-trips byte-identically; it is isolated in history
// so a single undo reverts the whole auto-close.

import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, Prec } from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";

// Derive SyntaxNode from syntaxTree's return type (same strategy as
// fenced-code-body.ts / list-indent-keymap.ts — @lezer/common is a direct dep as
// of PR #66, derived rather than imported to keep the direct-dep surface narrow).
type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

/** The innermost `FencedCode` ancestor of `pos` (biased left so a caret at the
 *  END of the opener line still resolves into the node), or null. */
function fencedCodeAt(tree: Tree, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, -1); n !== null; n = n.parent) {
    if (n.name === "FencedCode") {
      return n;
    }
  }
  return null;
}

/** The opener line's leading run turned into a same-width CONTINUATION prefix:
 *  blockquote `>` markers and whitespace are kept verbatim; every other char (a
 *  list marker like `-` or `1.`) becomes a space so the inserted lines align at
 *  the block's content column instead of starting a fresh list item. */
function continuationPrefix(lead: string): string {
  let out = "";
  for (const ch of lead) {
    out += ch === ">" || ch === " " || ch === "\t" ? ch : " ";
  }
  return out;
}

/** Enter: on an UNCLOSED ```-fence opener line, insert an empty body line + a
 *  matching closing fence and land the caret on the body line. Returns false in
 *  every other case so the default Enter (newline) still runs. */
export const autoCloseFenceOnEnter: Command = (view) => {
  const { state } = view;
  if (state.readOnly) {
    return false;
  }
  // Single empty caret only — a range selection or multi-cursor is not an
  // "opener confirm"; let the default Enter handle those.
  const sel = state.selection.main;
  if (!sel.empty || state.selection.ranges.length > 1) {
    return false;
  }
  const head = sel.head;
  const caretLine = state.doc.lineAt(head);
  // Parse to END OF DOCUMENT, not just the caret line: the already-closed guard
  // below reads the closing CodeMark, which sits BELOW the caret. A parse that
  // stopped at the opener line would omit the closer, misread an already-closed
  // fence as unclosed, and false-trigger a duplicate closer. (The sibling
  // list-indent-keymap parses only to line.to because it walks UP to a ListItem
  // ancestor — always above the caret; this guard needs a node below it.)
  const tree = ensureSyntaxTree(state, state.doc.length, 50) ?? syntaxTree(state);
  // Probe the END of the caret's line so a caret ANYWHERE on the opener line —
  // including at line start or on a leading `> ` / list prefix, which resolve to
  // the wrapping Blockquote / ListItem rather than the FencedCode — still lands
  // in the fenced node. The opener-line-number guard below rejects a body/closer
  // caret, so widening the probe cannot mis-fire on a non-opener line.
  const fenced = fencedCodeAt(tree, caretLine.to);
  if (fenced === null) {
    return false; // not in a fenced block (incl. inline code / plain text)
  }
  // CodeMark children are the fences: one → unclosed (open runs to EOF), two →
  // already closed (a closer follows). Same idiom as fenced-code-body.ts.
  const marks = fenced.getChildren("CodeMark");
  if (marks.length === 0 || marks.length >= 2) {
    return false; // malformed, or already closed → default Enter
  }
  const openMark = marks[0];
  const openerLine = state.doc.lineAt(openMark.from);
  // Only the OPENER line triggers; a caret in the body / on the closer keeps
  // Enter's default newline.
  if (caretLine.number !== openerLine.number) {
    return false;
  }
  const fence = state.sliceDoc(openMark.from, openMark.to); // ``` / ```` / ~~~
  const cont = continuationPrefix(state.sliceDoc(openerLine.from, openMark.from));
  // Insert AFTER the whole opener line (never split its info string): an empty
  // body line then the closing fence, both prefixed for the block context.
  const insert = `\n${cont}\n${cont}${fence}`;
  const caret = openerLine.to + 1 + cont.length; // end of the empty body line
  view.dispatch({
    changes: { from: openerLine.to, insert },
    selection: EditorSelection.cursor(caret),
    userEvent: "input.complete",
    // Own undo group: one undo reverts the whole auto-close, and it never
    // coalesces with the just-typed opener or subsequent body typing.
    annotations: isolateHistory.of("full"),
    scrollIntoView: true,
  });
  return true;
};

/** Keymap: Enter → auto-close an unclosed fence opener. Prec.high so it is tried
 *  before CodeMirror's default Enter; it returns false for every non-trigger so
 *  the default still runs. */
export function fencedCodeEnterKeymap() {
  return Prec.high(keymap.of([{ key: "Enter", run: autoCloseFenceOnEnter }]));
}
