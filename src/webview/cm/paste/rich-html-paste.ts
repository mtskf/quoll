// CodeMirror paste handler: when the clipboard carries a `text/html` fragment
// that converts to Markdown, insert the Markdown instead of the raw HTML/plain
// text. Mirrors html-table-paste.ts exactly — Prec.high, defer-on-null (return
// false WITHOUT preventDefault so pasteUrlOverSelection / listReindentPaste /
// imagePaste / CM's default plain-text paste still run), preventDefault only
// AFTER committing to insert, read-only swallow, and one dispatch through the
// normal edit-sync → host write-lock → validateMarkdownForWrite pipeline. It sits
// AFTER the table / URL / list handlers and BEFORE imagePaste (see editor.ts).

import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { caretInCode } from "../list/list-tree.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

function blockPrefix(before: string): string {
  if (before === "" || before.endsWith("\n\n")) {
    return "";
  }
  return before.endsWith("\n") ? "\n" : "\n\n";
}

function blockSuffix(after: string): string {
  if (after === "") {
    return "\n";
  }
  if (after.startsWith("\n\n")) {
    return "";
  }
  return after.startsWith("\n") ? "\n" : "\n\n";
}

export function richHtmlPaste(opts: { canWrite: () => boolean }): Extension {
  return Prec.high(
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const html = event.clipboardData?.getData("text/html");
        if (!html) {
          return false; // no HTML flavour → defer
        }
        const md = htmlToMarkdown(html);
        if (md === null) {
          return false; // nothing convertible / cap breached → defer to plain paste
        }
        const { from, to } = view.state.selection.main;
        // Caret / selection touching a fenced or indented code block: a converted
        // fragment can corrupt either kind — a <pre> becomes a ``` fenced snippet whose
        // delimiters would prematurely close a surrounding *fence*, while inside an
        // *indented* (4-space) block the blockPrefix/blockSuffix blank-line separators
        // (and any non-indented inserted line) would terminate the block early. Check
        // BOTH endpoints so a selection that starts in prose and extends into code (or
        // vice versa) also defers, not just an empty caret. Mirrors listReindentPaste's
        // caretInCode guard.
        if (caretInCode(view.state, from) || caretInCode(view.state, to)) {
          // Defer to plain-text paste so the raw text lands verbatim, structure intact.
          // Only defer when a plain-text/uri fallback exists: CM's core paste falls back
          // to getData("text/plain") || getData("text/uri-list"), and doPaste("") would
          // replace a non-empty selection with nothing — deleting selected code. With an
          // HTML-only clipboard, consume the event without converting or deleting.
          const hasPlainFallback =
            !!event.clipboardData?.getData("text/plain") ||
            !!event.clipboardData?.getData("text/uri-list");
          if (hasPlainFallback) {
            return false;
          }
          event.preventDefault();
          return true;
        }
        event.preventDefault();
        if (!opts.canWrite()) {
          return true; // read-only: swallow, no fallback insert (mirrors siblings)
        }
        const before = view.state.doc.sliceString(0, from);
        const after = view.state.doc.sliceString(to);
        const insert = blockPrefix(before) + md + blockSuffix(after);
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
