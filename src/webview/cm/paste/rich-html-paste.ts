// CodeMirror paste handler: when the clipboard carries a `text/html` fragment
// that converts to Markdown AND that conversion actually emitted Markdown syntax,
// insert the Markdown instead of the raw HTML/plain text. A fragment can convert
// perfectly and still not be inserted — see the third defer below.
//
// Follows html-table-paste.ts — Prec.high, defer (return false WITHOUT
// preventDefault so pasteUrlOverSelection / listReindentPaste / imagePaste / CM's
// default plain-text paste still run), preventDefault only AFTER committing to
// insert, read-only swallow, and one dispatch through the normal edit-sync → host
// write-lock → validateMarkdownForWrite pipeline. It sits AFTER the table / URL /
// list handlers and BEFORE imagePaste (see editor.ts).
//
// It deviates from that sibling in one way: there are THREE defer conditions —
// caret/selection in code, a null conversion, and a conversion that emitted no
// syntax — and the last has no counterpart in html-table-paste.ts. Every one that
// can fire over a non-empty selection first requires something for CM to fall
// back to, or its own defer would delete the selection (see hasPlainFallback).

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

/** Would CM's own paste handler insert anything if this handler deferred?
 *
 *  CM core runs `doPaste(view, getData("text/plain") || getData("text/uri-list"))`,
 *  and `doPaste("")` dispatches an empty insert over the selection — i.e. deleting
 *  it. EVERY defer path that can fire over a non-empty selection must therefore
 *  check this first and consume the event itself instead of deferring into that
 *  deletion. Written once so a change in CM's fallback order is found once. */
function hasPlainFallback(event: ClipboardEvent): boolean {
  const data = event.clipboardData;
  return !!data && (!!data.getData("text/plain") || !!data.getData("text/uri-list"));
}

/** Does the clipboard carry a file item (a copied image, typically)? Such a paste
 *  belongs to imagePaste, which is registered AFTER this handler (editor.ts), so
 *  consuming the event here would stop a genuine image paste from ever reaching
 *  it — the document would simply be left untouched. `files.length` is a
 *  deliberate proxy for imagePaste's own `items[].kind === "file"` scan: it is the
 *  cheaper check, it cannot miss a file item, and the optional chaining keeps it
 *  working against clipboard doubles that implement only `getData`. */
function hasFileItem(event: ClipboardEvent): boolean {
  return (event.clipboardData?.files?.length ?? 0) > 0;
}

export function richHtmlPaste(opts: { canWrite: () => boolean }): Extension {
  return Prec.high(
    EditorView.domEventHandlers({
      paste: (event, view) => {
        const html = event.clipboardData?.getData("text/html");
        if (!html) {
          return false; // no HTML flavour → defer
        }
        const { from, to } = view.state.selection.main;
        // Caret / selection touching a fenced or indented code block: a converted
        // fragment can corrupt either kind — a <pre> becomes a ``` fenced snippet whose
        // delimiters would prematurely close a surrounding *fence*, while inside an
        // *indented* (4-space) block the blockPrefix/blockSuffix blank-line separators
        // (and any non-indented inserted line) would terminate the block early. Check
        // BOTH endpoints so a selection that starts in prose and extends into code (or
        // vice versa) also defers, not just an empty caret. Mirrors listReindentPaste's
        // caretInCode guard. Checked BEFORE htmlToMarkdown so the in-code decision does
        // not depend on convertibility: whether a fragment happens to convert says
        // nothing about whether inserting Markdown here is safe, and running the
        // conversion first would make an unconvertible clipboard take a different
        // path through this handler than a convertible one over the same code.
        if (caretInCode(view.state, from) || caretInCode(view.state, to)) {
          // Defer to plain-text paste so the raw text lands verbatim, structure
          // intact — but only when there is something to fall back to, or CM's
          // doPaste("") would delete the selected code (see hasPlainFallback).
          if (hasPlainFallback(event)) {
            return false;
          }
          event.preventDefault();
          return true;
        }
        const converted = htmlToMarkdown(html);
        if (converted === null) {
          // Nothing convertible (whitespace-only, cap breached, parse error) → the
          // clipboard's own bytes are the best available paste. Same requirement as
          // the caretInCode branch above: with no plain fallback and a real
          // selection, deferring hands CM a doPaste("") that replaces the selection
          // with nothing — an HTML-only clipboard (a remote <img>, say) would
          // silently delete the user's text. Consume the event instead, unless a
          // file item means imagePaste still has a real paste to perform.
          if (!hasPlainFallback(event) && !hasFileItem(event) && from !== to) {
            event.preventDefault();
            return true;
          }
          return false; // defer to plain paste / imagePaste
        }
        // The conversion emitted escaped text and line structure only — no
        // emphasis / link / code / heading / list / quote / table / rule. The
        // conversion's deliberate escaping (which exists so that text inside
        // GENUINELY rich content cannot activate a construct the user did not
        // author) would mangle Markdown the user wrote by hand:
        // `- [ ]` becomes `\- \[ \]`. Defer so CM's default paste inserts the
        // clipboard's own bytes — byte-identical to typing them, so the "pasted
        // text never activates a construct hand-typed text would not" invariant
        // still holds. Requires a plain fallback to defer into, for the reason
        // hasPlainFallback documents.
        //
        // What this deliberately gives up: the `text/html` flavour is NOT
        // strictly redundant here. LINE STRUCTURE is real information only it
        // carries — a `<br>` hard break arrives as whatever the plain flavour
        // spells (typically a soft `\n`, which renders as a space) instead of the
        // `\`-escaped hard break the conversion would have written, and
        // `<div>`-per-line blocking survives only as far as the plain flavour
        // mirrors it. That is an empirical bet on clipboard producers — in
        // practice they emit a `text/plain` that mirrors their own block
        // structure — not a logical identity, and it is taken because re-escaping
        // Markdown the user typed by hand is the worse failure. Pinned by "loses
        // a lone <br> hard break to the plain fallback" in
        // cm-rich-html-paste.test.ts; change either only with a decision record.
        // Read-only needs no check HERE: this returns before the canWrite() gate
        // below, and CM's builtin paste handler early-returns on
        // `view.state.readOnly`. That is sound because EditorState.readOnly /
        // EditorView.editable (editor.ts's `editableComp`) are reconfigured from
        // the same `canWrite` wire value that drives opts.canWrite(), so the two
        // cannot diverge — the same invariant html-table-paste.ts relies on.
        if (!converted.emittedMarkdownSyntax && hasPlainFallback(event)) {
          return false;
        }
        const md = converted.markdown;
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
