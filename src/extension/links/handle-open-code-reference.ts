// Async orchestration for a webview open-code-reference. Pure validation lives
// in resolve-code-reference.ts; this adds the existence pick, the text-editor
// open, and error capture. Security-reject (out-of-scope / invalid) is
// log-only; a genuinely missing file gets light not-found feedback (never a
// silent dead click, per handle-open-link's "a dead click is never silent"
// posture); a reveal failure raises the error toast.

import type { Uri } from "vscode";
import {
  type ResolveCodeReferenceDeps,
  resolveCodeReferenceCandidates,
} from "./resolve-code-reference.js";

const OPEN_CODE_REF_FAILURE_MESSAGE =
  "Quoll: couldn't open the referenced file. See the extension host log for details.";

function sanitizeForLog(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — sanitising untrusted control bytes for logging.
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 64);
}

export type HandleOpenCodeReferenceDeps = ResolveCodeReferenceDeps & {
  /** True only when `target` exists, is a regular file, AND canonicalises
   *  (realpath) within `root` — the authoritative containment check. */
  pathExists: (target: Uri, root: Uri) => Thenable<boolean>;
  revealInTextEditor: (
    uri: Uri,
    line: number | undefined,
    col: number | undefined
  ) => Thenable<unknown>;
  showError: (message: string) => void;
  /** Light, non-silent feedback when a well-formed reference points nowhere. */
  showNotFound: (path: string) => void;
};

export async function handleOpenCodeReference(
  ref: { path: string; line?: number; col?: number },
  deps: HandleOpenCodeReferenceDeps
): Promise<void> {
  try {
    const candidates = resolveCodeReferenceCandidates(ref.path, deps);
    if (candidates.length === 0) {
      console.warn("[quoll] open-code-reference dropped: no in-scope target", {
        pathPreview: sanitizeForLog(ref.path),
      });
      return;
    }
    let target: Uri | undefined;
    for (const candidate of candidates) {
      if (await deps.pathExists(candidate.target, candidate.root)) {
        target = candidate.target;
        break;
      }
    }
    if (target === undefined) {
      deps.showNotFound(ref.path);
      return;
    }
    await deps.revealInTextEditor(target, ref.line, ref.col);
  } catch (err) {
    console.error("[quoll] open-code-reference failed", err);
    deps.showError(OPEN_CODE_REF_FAILURE_MESSAGE);
  }
}
