// CodeMirror paste handler: when the clipboard carries a `text/html` flavour
// containing a `<table>`, insert an equivalent GFM Markdown table instead of the
// raw HTML/plain-text. Every other paste is left untouched — the handler returns
// `false` (without preventDefault) so `pasteUrlOverSelection` (url-link-paste.ts),
// the image paste pipeline (image-paste.ts), and CM's default plain-text paste
// still run.
//
// Mounted at Prec.high so it arbitrates before those handlers: on a convertible
// table it consumes the event; otherwise it defers. The insert rides the normal
// dispatch → updateListener → edit-sync → host write-lock → validateMarkdownForWrite
// pipeline (no raw write path).

import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { htmlTableToGfm } from "./html-table-to-gfm.js";

/** Leading separator so the inserted table starts on its own line, preceded by a
 *  blank line (GFM needs the header row on a fresh line). `""` at doc start or when
 *  a blank line already precedes. */
function blockPrefix(before: string): string {
  if (before === "" || before.endsWith("\n\n")) {
    return "";
  }
  return before.endsWith("\n") ? "\n" : "\n\n";
}

/** Trailing separator so following content is not glued to the last row. */
function blockSuffix(after: string): string {
  if (after === "") {
    return "\n";
  }
  if (after.startsWith("\n\n")) {
    return "";
  }
  return after.startsWith("\n") ? "\n" : "\n\n";
}

export function htmlTablePaste(opts: { canWrite: () => boolean }): Extension {
  return Prec.high(
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const html = event.clipboardData?.getData("text/html");
        if (!html) {
          return false; // no HTML flavour → let normal paste handlers run
        }
        const gfm = htmlTableToGfm(html);
        if (gfm === null) {
          return false; // not a convertible table → defer to the other handlers
        }
        // preventDefault ONLY here, AFTER the null-check. This is intentionally the
        // OPPOSITE order from imagePaste (which preventDefaults before its
        // capability check): moving it earlier would swallow non-table HTML pastes.
        event.preventDefault();
        // Read-only: swallow silently with NO fallback insert (mirrors imagePaste).
        // canWrite() is the same source that drives EditorState.readOnly, so they
        // cannot diverge — no redundant view.state.readOnly check.
        if (!opts.canWrite()) {
          return true;
        }
        // Insert at the MAIN selection range; multi-cursor collapses to it (a block
        // table under multi-cursor is degenerate — acceptable). The handler runs
        // synchronously inside the live DOM event, so the view is always alive at
        // dispatch time (unlike imagePaste's async FileReader path).
        const { from, to } = view.state.selection.main;
        const before = view.state.doc.sliceString(0, from);
        const after = view.state.doc.sliceString(to);
        const insert = blockPrefix(before) + gfm + blockSuffix(after);
        view.dispatch({
          changes: { from, to, insert },
          selection: { anchor: from + insert.length },
          scrollIntoView: true,
          userEvent: "input.paste",
        });
        return true;
      },
    })
  );
}
