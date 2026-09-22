// Dispatch wrapper for the whole-document Format command. Computes the format
// edits with the pure formatDocumentEdits(), VALIDATES them via applyEdits (the
// one place that throws on overlapping edits — CM6 would instead silently
// mis-compose overlaps into corruption), size-checks the result against the
// edit-sync content cap, and only then applies them as ONE `{ changes }`
// transaction — a single undo step riding the normal dispatch -> edit-sync ->
// host write-lock pipeline (no raw write path). Selection auto-maps through the
// ChangeSet. No hasFocus guard (palette-invoked, no selection dependency);
// read-only IS guarded (raw changes bypass the facet). Every failure path is
// caught so a pathological document can neither crash the message loop nor
// silently corrupt bytes.
import type { EditorView } from "@codemirror/view";
import { applyEdits } from "../../../markdown/format/edit.js";
import { formatDocumentEdits } from "../../../markdown/format/index.js";
import { MAX_CONTENT_LENGTH } from "../../../shared/protocol.js";
import { type DocumentEol, quollDocumentEol } from "../seed.js";

/** Length of `text` once its `\n` newlines are serialized with the DOCUMENT's
 *  own EOL (edit-sync posts the CRLF-joined content; the LF-internal length
 *  under-counts). The parameter is `DocumentEol`, not `string`, so the one
 *  wrong argument — CM's `state.lineBreak`, which is always `"\n"` here because
 *  `EditorState.lineSeparator` is never provided (cm/seed.ts) — is a type error
 *  rather than something prose has to warn about. Pass
 *  `state.facet(quollDocumentEol)`. */
export function outboundContentLength(text: string, eol: DocumentEol): number {
  if (eol.length <= 1) {
    return text.length;
  }
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      newlines++;
    }
  }
  return text.length + newlines * (eol.length - 1);
}

export function runFormatDocument(view: EditorView): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const source = view.state.doc.toString();
  let edits: ReturnType<typeof formatDocumentEdits>;
  let formatted: string;
  try {
    edits = formatDocumentEdits(source);
    // Connect the overlap guard to the runtime path: applyEdits THROWS on
    // overlapping edits, so a rule bug becomes a caught bail, not corruption.
    formatted = applyEdits(source, edits);
  } catch (err) {
    console.error(
      "[quoll] Format Document aborted (formatter/edit error); no changes applied.",
      err
    );
    return false;
  }
  if (edits.length === 0 || formatted === source) {
    return false;
  }
  // The document's EOL comes from Quoll's own facet, not state.lineBreak:
  // EditorState.lineSeparator is deliberately never provided (cm/seed.ts), so
  // state.lineBreak is always "\n" and would under-count a CRLF document's
  // outbound bytes by one per line — letting an oversized result mutate the
  // document before postEditMessage refuses to post it. The `DocumentEol`
  // parameter now rejects `state.lineBreak` outright; this note survives because
  // WHICH of the two the size check must read is not something the type says.
  if (outboundContentLength(formatted, view.state.facet(quollDocumentEol)) > MAX_CONTENT_LENGTH) {
    // postEditMessage would refuse to post the oversized (CRLF-serialized) content
    // and show the webview serialize-error banner, leaving the doc formatted but
    // unsaved. Bail before mutating instead.
    console.error("[quoll] Format Document aborted: result exceeds the content size limit.");
    return false;
  }
  // The formatter works in CM's LF-internal space and CM splits string inserts
  // with its own default /\r\n?|\n/ — EditorState.lineSeparator is deliberately
  // never provided (cm/seed.ts) — so a multi-line insert needs NO conversion.
  // This was the one site in the webview that carried its own; it now takes the
  // same path as every other insert. `outboundContentLength` above still needs
  // the document's EOL: how long these bytes are once the HOST sees them is an
  // EOL-dependent question, and that is a different question from how CM splits
  // them on the way in.
  try {
    view.dispatch({ changes: edits, userEvent: "quoll.formatDocument" });
  } catch (err) {
    console.error("[quoll] Format Document dispatch failed; no changes applied.", err);
    return false;
  }
  return true;
}
