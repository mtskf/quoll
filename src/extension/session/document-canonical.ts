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
import type { DocumentMessage, ThemeKind } from "../../shared/protocol.js";
import { buildDocumentMessage } from "./document-message.js";

/** Normalize a raw string's line endings to `eol`. The string-level core of
 *  `canonicalDocumentText`, exposed so a caller that ALREADY holds the raw
 *  bytes (e.g. the settlement pre-apply snapshot — a literal `getText()` read
 *  captured before applyEdit) can canonicalise them for a like-for-like compare
 *  against a canonical settlement read WITHOUT a second `getText()`. */
export function canonicalizeText(text: string, eol: EndOfLine): string {
  const separator = eol === EndOfLine.CRLF ? "\r\n" : "\n";
  return text.replace(/\r\n|\r|\n/g, separator);
}

export function canonicalDocumentText(document: Pick<TextDocument, "eol" | "getText">): string {
  return canonicalizeText(document.getText(), document.eol);
}

export function buildDocumentMessageFromDocument(
  document: Pick<TextDocument, "eol" | "getText">,
  metadata: {
    docVersion: number;
    themeKind: ThemeKind;
    canWrite: boolean;
    externalEpoch: number;
    epochGeneration: number;
  }
): DocumentMessage {
  return buildDocumentMessage({ content: canonicalDocumentText(document), ...metadata });
}
