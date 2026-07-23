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

/** Length of `text` once its `\n` newlines are serialized with `lineBreak`
 *  (edit-sync posts the CRLF-joined content; the LF-internal length under-counts). */
export function outboundContentLength(text: string, lineBreak: string): number {
  if (lineBreak.length <= 1) {
    return text.length;
  }
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      newlines++;
    }
  }
  return text.length + newlines * (lineBreak.length - 1);
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
  if (outboundContentLength(formatted, view.state.lineBreak) > MAX_CONTENT_LENGTH) {
    // postEditMessage would refuse to post the oversized (CRLF-serialized) content
    // and show the webview serialize-error banner, leaving the doc formatted but
    // unsaved. Bail before mutating instead.
    console.error("[quoll] Format Document aborted: result exceeds the content size limit.");
    return false;
  }
  try {
    view.dispatch({ changes: edits, userEvent: "quoll.formatDocument" });
  } catch (err) {
    console.error("[quoll] Format Document dispatch failed; no changes applied.", err);
    return false;
  }
  return true;
}
