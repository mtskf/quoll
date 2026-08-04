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
// What a defer actually reaches: CM runs handlers in precedence order — within one
// precedence, in extension order — stopping at the first that returns true. This
// handler is Prec.high and registered AFTER htmlTablePaste / pasteUrlOverSelection /
// listReindentPaste (same precedence → extension order decides); imagePaste is at
// DEFAULT precedence, so it runs after every Prec.high handler regardless of where
// its line sits in editor.ts. So by the time control arrives here those three have
// already declined, and deferring hands the event to imagePaste and then to CM's
// default plain-text paste — nobody else.
//
// Two of its four defer sites are shared with that sibling — `!html` and a null
// conversion (`gfm === null` there). What deviates: the caret/selection-in-code
// guard, the no-syntax defer, and the data-loss guard wrapped around the
// null-conversion defer — none of which html-table-paste.ts has. Of those, the
// three that could instead CONSUME the event first require something for CM to fall
// back to (or an image file item for imagePaste to act on), because their own defer
// would otherwise delete the selection — see canDeferWithoutDataLoss, which the two
// consume branches share, and pasteWouldBeDropped beneath it: the ONE place "can
// anything downstream insert this clipboard" is answered, over hasPlainFallback /
// hasImageFileItem. All three sites ask it through that funnel.
// The `!html` defer is unconditional: with no HTML flavour this handler has nothing
// to insert either, so CM's own fallback behaviour is the whole story there.

import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

// Cross-directory into cm/image/ deliberately: the "is this an image item"
// question belongs to the handler that ingests them, and borrowing its definition
// is what keeps this handler's defer set from drifting wider (see
// hasImageFileItem). No cycle — nothing under cm/image/ imports cm/paste/.
import { isIngestibleImageItem } from "../image/image-paste.js";
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
 *  The membership test is IMPORTED, not restated: `isIngestibleImageItem` is
 *  imagePaste's own definition of what it ingests, so this handler cannot defer on
 *  a wider set than that handler accepts. It used to restate the conditions, and a
 *  restatement that over-matches is not a conservative approximation — it is data
 *  loss: this handler defers, imagePaste declines, and CM's core `doPaste("")`
 *  replaces the selection with nothing. Two restatements shipped into review
 *  (`files.length`, which also matches a copied PDF; then `getAsFile() !== null`,
 *  which lets an `undefined` return through) before the definition was shared.
 *  "Cannot miss a file item" is the wrong property to optimise for; not
 *  over-matching is the one that protects the document — and sharing the
 *  definition is what makes over-matching unconstructible rather than merely
 *  forbidden by a comment.
 *
 *  What stays local here is only the CLIPBOARD-shaped part: with no `items` at all
 *  the answer is false. That is the safe side: at the two consume branches false
 *  falls back to swallowing the event, which leaves the document intact (at the
 *  no-syntax defer it falls back to inserting this conversion — also
 *  non-destructive), whereas a wrong true routes to the deletion above. */
function hasImageFileItem(event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) {
    return false;
  }
  return Array.from(items).some(isIngestibleImageItem);
}

/** Can NOTHING downstream insert this clipboard? No plain / uri-list bytes for CM
 *  core, no image file item for imagePaste — so whatever this handler decides at a
 *  branch that will not insert the conversion, the paste produces nothing: consume
 *  and it is swallowed here; defer and CM's `doPaste("")` is a no-op at a caret or
 *  a deletion over a selection. THIS is the condition a diagnostic belongs on. The
 *  warnings used to sit on the consume decision instead, which tracked "did we
 *  protect the selection" rather than "did the paste vanish" — and so said nothing
 *  at all for the bare-caret case, the one where the user sees a paste do nothing
 *  and has no trace to look at. */
function pasteWouldBeDropped(event: ClipboardEvent): boolean {
  return !hasPlainFallback(event) && !hasImageFileItem(event);
}

/** May this handler defer without risking the user's text?
 *
 *  A defer hands the event to imagePaste and then to CM core, and CM core runs
 *  `doPaste("")` when the clipboard has no plain/uri bytes — which over a
 *  non-empty selection replaces it with nothing. Three independent things make a
 *  defer harmless:
 *   - a plain / uri-list fallback — CM core inserts those bytes instead of nothing;
 *   - an image file item — imagePaste consumes the event first, so CM core never
 *     runs; and consuming HERE would starve the only handler that can perform that
 *     paste, leaving the document untouched;
 *   - an empty MAIN selection — `doPaste("")` at a bare caret is a no-op, so
 *     consuming would swallow the event to protect nothing. Only the main range is
 *     tested: under multi-cursor a non-empty SECONDARY range would still be cleared
 *     by CM's replaceSelection(""). Accepted, mirroring html-table-paste.ts's
 *     collapse-to-main — a rich paste under multi-cursor is degenerate anyway.
 *
 *  Both consume branches below (in-code paste, null conversion) need exactly this
 *  test, so they share it rather than restating it: the two must not drift, since
 *  each one's `false` answer is a decision to swallow a paste. The no-syntax defer
 *  site deliberately does NOT use it — see the comment there. */
function canDeferWithoutDataLoss(event: ClipboardEvent, from: number, to: number): boolean {
  return !pasteWouldBeDropped(event) || from === to;
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
          // intact — but only when deferring cannot cost the user anything. With no
          // plain fallback, no image item and a real selection, deferring hands CM a
          // doPaste("") that would delete the selected code, so consume instead.
          // canDeferWithoutDataLoss holds the reasoning for all three exemptions;
          // the `converted === null` branch below needs the same test and shares it.
          // Warn on the DROP, not on the consume: at a bare caret this branch
          // defers and CM's doPaste("") does nothing, which is just as silent for
          // the user and just as puzzling. See pasteWouldBeDropped.
          if (pasteWouldBeDropped(event)) {
            console.warn("[quoll] rich paste: HTML-only clipboard dropped over code");
          }
          if (canDeferWithoutDataLoss(event, from, to)) {
            return false;
          }
          event.preventDefault();
          return true;
        }
        const converted = htmlToMarkdown(html);
        if (converted === null) {
          // Nothing convertible (whitespace-only, cap breached, parse error) → the
          // clipboard's own bytes are the best available paste. Same requirement as
          // the caretInCode branch above, hence the same test: with nothing to defer
          // into and a real selection, deferring hands CM a doPaste("") that replaces
          // the selection with nothing — an HTML-only clipboard (a remote <img>, say)
          // would silently delete the user's text. Consume the event instead.
          // Same split as the branch above: the warning follows the dropped paste,
          // not the consume decision.
          if (pasteWouldBeDropped(event)) {
            console.warn("[quoll] rich paste: unconvertible HTML-only clipboard dropped");
          }
          if (!canDeferWithoutDataLoss(event, from, to)) {
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
        // An image file item is the second thing this defer can land in: imagePaste
        // consumes the event and performs the paste itself, so unlike a bare defer
        // it can never reach CM's doPaste(""). Without this clause a syntax-free
        // fragment arriving BESIDE a copied image (a caption <div>, no text/plain)
        // was converted and consumed here, and the image was never pasted at all.
        // Both landing places are ONE question, asked through the one funnel:
        // `!pasteWouldBeDropped(event)` IS "a plain fallback or an image file item
        // exists", so a future third absorber is added there and this site follows.
        // Spelling the disjunction out here instead would be a second answer to the
        // question canDeferWithoutDataLoss already asks — the drift this file's
        // shared predicates exist to remove.
        //
        // Deliberately NOT canDeferWithoutDataLoss itself: an empty selection is no
        // reason to defer here, because NOT deferring inserts this conversion rather
        // than consuming the event — there is no swallowed paste to avoid.
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
        //
        // Read-only needs no check HERE: this returns before the canWrite() gate
        // below, and CM's builtin paste handler early-returns on
        // `view.state.readOnly`. That is sound because EditorState.readOnly /
        // EditorView.editable (editor.ts's `editableComp`) are reconfigured from
        // the same `canWrite` wire value that drives opts.canWrite(), so the two
        // cannot diverge — the same invariant html-table-paste.ts relies on.
        if (!converted.emittedMarkdownSyntax && !pasteWouldBeDropped(event)) {
          return false;
        }
        // NO image-file exemption here, unlike the two consume branches above, and
        // deliberately so. This path INSERTS the conversion, so exempting would mean
        // deferring — handing imagePaste an event whose text this handler has no way
        // to pass along, and the prose would be dropped to paste the bitmap alone.
        // On a clipboard carrying both (Word / Outlook copying a paragraph with an
        // embedded picture) keeping the prose is the smaller loss. The dominant
        // image clipboard is unaffected: "Copy image" carries a bare <img>, which
        // converts to null and takes the exempted branch above. Carrying fallback
        // text into imagePaste would remove the trade-off entirely; that is a
        // protocol change, tracked separately. Pinned by "inserts a syntax-bearing
        // conversion even when an image file rides along".
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
