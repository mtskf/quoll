// CodeMirror paste handler: when the clipboard carries a `text/html` fragment
// that converts to Markdown AND that conversion actually emitted Markdown syntax,
// insert the Markdown instead of the raw HTML/plain text. A fragment can convert
// perfectly and still not be inserted — see the third defer below.
//
// Follows html-table-paste.ts — Prec.high, defer (return false WITHOUT
// preventDefault so the handlers after this one still run), preventDefault only
// AFTER committing to insert, read-only swallow, and one dispatch through the
// normal edit-sync → host write-lock → validateMarkdownForWrite pipeline.
//
// What a defer actually reaches: this handler is registered AFTER htmlTablePaste /
// pasteUrlOverSelection / listReindentPaste and BEFORE imagePaste (editor.ts), and
// CM runs same-precedence handlers in extension order, stopping at the first that
// returns true. So by the time control arrives here those three have already
// declined, and deferring hands the event to imagePaste and then to CM's default
// plain-text paste — nobody else.
//
// It deviates from that sibling on three of its four defer sites: `!html` is the
// shared one, while caret/selection in code, a null conversion, and a conversion
// that emitted no syntax have no counterpart in html-table-paste.ts. Every site
// that can fire over a non-empty selection first requires something for CM to fall
// back to (or an image file item for imagePaste to act on), because its own defer
// would otherwise delete the selection — see hasPlainFallback / hasImageFileItem.

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

/** Does the clipboard carry an image file item — one imagePaste will actually act
 *  on? imagePaste is registered AFTER this handler (editor.ts), so consuming such
 *  an event here would starve the only handler that can perform the paste and the
 *  document would simply be left untouched.
 *
 *  This test MUST stay a SUBSET of imagePaste's own `imageFilesFrom` scan
 *  (image-paste.ts) — same three conditions, in the same order: `kind === "file"`,
 *  an `image/` type, and a non-null `getAsFile()`. A looser test is not a
 *  conservative approximation, it is data loss: this handler would defer into a
 *  handler that declines, and CM's core `doPaste("")` then replaces the selection
 *  with nothing. Do NOT relax it back to a cheaper proxy such as `files.length`
 *  (which also matches a copied PDF) — "cannot miss a file item" is the wrong
 *  property; not over-matching is the one that protects the document.
 *
 *  With no `items` at all the answer is false. That is the safe side: false routes
 *  to consuming the event, which leaves the document intact, whereas a wrong true
 *  routes to the deletion above. */
function hasImageFileItem(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) {
    return false;
  }
  return Array.from(items).some(
    (item) => item.kind === "file" && item.type.startsWith("image/") && item.getAsFile() !== null
  );
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
          // The other two exemptions are the same ones the `converted === null`
          // branch below carries, for the same reasons: an image file item means
          // imagePaste has a real paste to perform and consuming here would starve
          // it, and at a bare caret there is no selection for doPaste("") to
          // destroy — so consuming would swallow the event to protect nothing.
          if (hasPlainFallback(event) || hasImageFileItem(event) || from === to) {
            return false;
          }
          console.warn("[quoll] rich paste: HTML-only clipboard dropped over a code selection");
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
          // silently delete the user's text. Consume the event instead, unless an
          // image file item means imagePaste still has a real paste to perform.
          if (!hasPlainFallback(event) && !hasImageFileItem(event) && from !== to) {
            console.warn("[quoll] rich paste: unconvertible HTML-only clipboard dropped");
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
        // An image file item is the second thing this defer can land in: imagePaste
        // consumes the event and performs the paste itself, so unlike a bare defer
        // it can never reach CM's doPaste(""). Without this clause a syntax-free
        // fragment arriving BESIDE a copied image (a caption <div>, no text/plain)
        // was converted and consumed here, and the image was never pasted at all.
        if (
          !converted.emittedMarkdownSyntax &&
          (hasPlainFallback(event) || hasImageFileItem(event))
        ) {
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
