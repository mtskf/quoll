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

export type EditVerdict =
  | { kind: "accept" }
  | { kind: "no-op" }
  | { kind: "stale" }
  | { kind: "readonly" }
  | { kind: "parse-failed"; error: MarkdownError };

export type DecideEditInput = {
  baseDocVersion: number;
  lastAppliedDocVersion: number;
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
  // stale next: strict equality so unexpected-newer (impossible from a
  // correct webview) and unexpected-older both resync.
  if (input.baseDocVersion !== input.lastAppliedDocVersion) {
    return { kind: "stale" };
  }
  // no-op before parse: identical bytes can be answered without paying
  // for a parse (and avoids surfacing a parse-failed verdict on content
  // that already matches the current document text). The comparison is
  // against the supplied `currentContent`, which the host now canonicalizes.
  if (input.content === input.currentContent) {
    return { kind: "no-op" };
  }
  const validate = input.markdownValidator ?? validateMarkdownForWrite;
  const result = validate(input.content);
  if (!result.ok) {
    return { kind: "parse-failed", error: result.error };
  }
  return { kind: "accept" };
}
