// The single VS Code binding of the `DocumentWriteAdapter` seam, shared by both
// host-side writers (the panel's flushed-edit path and revert-rescue's restore).
// A sibling of execute-write.ts rather than part of it so the executor stays
// vscode-free. Every read is LIVE against `document` (the executor snapshots
// through the seam; nothing is captured at construction). Callers differ only in
// `apply`: the panel resets its edit lineage and honours a lazily-read test
// override, the rescue uses `workspace.applyEdit` directly.

import { Range, type TextDocument, WorkspaceEdit, workspace } from "vscode";
import { canonicalDocumentText, canonicalizeText } from "../session/document-canonical.js";
import type { DocumentWriteAdapter } from "./execute-write.js";

export function createDocumentWriteAdapter(
  document: TextDocument,
  apply: (edit: WorkspaceEdit) => PromiseLike<boolean> = (edit) => workspace.applyEdit(edit)
): DocumentWriteAdapter<WorkspaceEdit> {
  return {
    readText: () => document.getText(),
    readVersion: () => document.version,
    readCanonical: () => canonicalDocumentText(document),
    canonicalize: (text) => canonicalizeText(text, document.eol),
    build: (span) => {
      const edit = new WorkspaceEdit();
      edit.replace(
        document.uri,
        new Range(document.positionAt(span.from), document.positionAt(span.to)),
        span.insert
      );
      return edit;
    },
    apply,
  };
}
