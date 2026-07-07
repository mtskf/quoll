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
import type { DocumentMessage } from "../shared/protocol.js";
import { buildDocumentMessage } from "./document-message.js";

export function canonicalDocumentText(document: Pick<TextDocument, "eol" | "getText">): string {
  const separator = document.eol === EndOfLine.CRLF ? "\r\n" : "\n";
  return document.getText().replace(/\r\n|\r|\n/g, separator);
}

export function buildDocumentMessageFromDocument(
  document: Pick<TextDocument, "eol" | "getText">,
  metadata: { docVersion: number; isDarkTheme: boolean; canWrite: boolean }
): DocumentMessage {
  return buildDocumentMessage({ content: canonicalDocumentText(document), ...metadata });
}
