// Document-taking adapters that normalize EOL to the document's own `eol`.
//
// Why: VS Code's TextModel already normalizes EOL when it loads a file, so
// document.getText() is uniform in practice — but that is a VS Code
// *implementation* fact, not a public API contract, and is tested against
// only one engine. Routing BOTH the host→webview seed AND the inbound no-op
// comparison through canonicalDocumentText means QUOLL owns the single-EOL
// invariant the webview's CodeMirror line model relies on, symmetrically and
// across the supported engines.vscode range. The document-taking shape is
// what lets unit tests pin each wiring with a mixed-EOL fake document
// (reverting to raw getText() fails the test). Core API only: document.eol
// + getText().

import { EndOfLine, type TextDocument } from "vscode";
// DocumentMessage is defined in the protocol module; document-message.ts uses
// it internally but does NOT re-export it, so import the type from the source.
import type { DocumentEol, DocumentMessage } from "../../shared/protocol.js";
import { type BuildDocumentMessageInput, buildDocumentMessage } from "./document-message.js";

/** Everything a Document message carries besides its bytes and separator —
 *  derived from the builder input so both adapters below stay in lockstep
 *  with it. */
type DocumentMessageMetadata = Omit<BuildDocumentMessageInput, "content" | "eol">;

/** Normalize a raw string's line endings to `eol`. The string-level core of
 *  `canonicalDocumentText`, exposed so a caller that ALREADY holds the raw
 *  bytes (e.g. the settlement pre-apply snapshot — a literal `getText()` read
 *  captured before applyEdit) can canonicalise them for a like-for-like compare
 *  against a canonical settlement read WITHOUT a second `getText()`. */
export function canonicalizeText(text: string, eol: EndOfLine): string {
  return text.replace(/\r\n|\r|\n/g, documentEolOf(eol));
}

/** The single `EndOfLine` → wire separator mapping. `canonicalizeText` uses it
 *  too, so the separator the seed content is canonicalised to and the `eol`
 *  the Document carries on the wire cannot drift apart. */
export function documentEolOf(eol: EndOfLine): DocumentEol {
  return eol === EndOfLine.CRLF ? "\r\n" : "\n";
}

export function canonicalDocumentText(document: Pick<TextDocument, "eol" | "getText">): string {
  return canonicalizeText(document.getText(), document.eol);
}

export function buildDocumentMessageFromDocument(
  document: Pick<TextDocument, "eol" | "getText">,
  metadata: DocumentMessageMetadata
): DocumentMessage {
  return buildDocumentMessage({
    content: canonicalDocumentText(document),
    eol: documentEolOf(document.eol),
    ...metadata,
  });
}

/** The rejected-draft reseed: the webview's own draft bytes, passed through
 *  as-is (NOT canonicalised — the draft is what the user typed and must survive
 *  the rejection byte-for-byte), stamped with the document's `eol`. Taking the
 *  document, not a pre-read separator, is what lets a unit test pin the wire
 *  eol with a CRLF fake document. */
export function buildRejectedDraftFromDocument(
  document: Pick<TextDocument, "eol">,
  content: string,
  metadata: DocumentMessageMetadata
): DocumentMessage {
  return buildDocumentMessage({
    content,
    eol: documentEolOf(document.eol),
    ...metadata,
  });
}
