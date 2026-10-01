// Pure host-side decision for an inbound webview Edit.
//
// Returns a verdict instead of doing the side effect. The panel call site
// dispatches on the verdict: `accept` runs applyEdit + advances state,
// `stale` / `readonly` reposts the authoritative Document, `parse-failed`
// reposts + surfaces the error via window.showErrorMessage, `no-op`
// reposts the current Document without calling applyEdit (frozen-editor
// prevention — VS Code does NOT fire onDidChangeTextDocument for a
// WorkspaceEdit.replace whose replacement text equals the existing range
// text).
//
// Why this adapter does NOT import the write-gate internals directly:
// the host-side defense-in-depth re-parse lives behind
// validateMarkdownForWrite (in src/markdown/). Keeping the extension
// adapter free of direct markdown-bridge imports means churn in that
// layer does not ripple here. The validator is injected as a parameter
// (default = validateMarkdownForWrite) so the unit test can substitute a
// fake and exercise every arm deterministically.

import type { MarkdownError } from "../../markdown/errors.js";
import {
  type ValidateForWriteResult,
  validateMarkdownForWrite,
} from "../../markdown/validate-for-write.js";
import { sameTextIgnoringEol } from "../../shared/text-equality.js";

export type EditVerdict =
  | { kind: "accept" }
  | { kind: "no-op" }
  | { kind: "stale" }
  | { kind: "readonly" }
  | { kind: "parse-failed"; error: MarkdownError };

export type DecideEditInput = {
  // Is the Edit's base still the document's current text? Version bookkeeping
  // is the reducer's (host-session-core decides it: an exact version match, or
  // an older base the lineage proves still carries the live text); this module
  // is the content gate only.
  baseIsCurrent: boolean;
  canWrite: boolean;
  content: string;
  currentContent: string;
  markdownValidator?: (content: string) => ValidateForWriteResult;
};

export function decideEdit(input: DecideEditInput): EditVerdict {
  // Order: readonly → stale → no-op → parse-failed → accept.
  //
  // readonly first: cheap and definitive; a readonly Edit must never
  // touch applyEdit regardless of version state.
  if (!input.canWrite) {
    return { kind: "readonly" };
  }
  // stale next: the base is not provably the current text → resync.
  if (!input.baseIsCurrent) {
    return { kind: "stale" };
  }
  // no-op before parse: identical text can be answered without paying for a
  // parse (and avoids surfacing a parse-failed verdict on content that already
  // matches the current document text). EOL-insensitive: `currentContent` is
  // canonicalised to `document.eol`, while an Edit built before an EOL-mode
  // switch still carries the old line endings — the same text either way, so
  // it must not be validated or written.
  if (sameTextIgnoringEol(input.content, input.currentContent)) {
    return { kind: "no-op" };
  }
  const validate = input.markdownValidator ?? validateMarkdownForWrite;
  const result = validate(input.content);
  if (!result.ok) {
    return { kind: "parse-failed", error: result.error };
  }
  return { kind: "accept" };
}
