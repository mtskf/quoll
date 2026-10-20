// Rescue of a draft the host refused to write, after the tab is gone.
//
// Why this exists: when the write-gate rejects an edit, the rejected bytes live
// only in the host-session `rejection` state and the webview — the VS Code
// TextDocument never held them. So closing the tab raises no "Save changes?"
// prompt, and revert-rescue (which compares TextDocument bytes) cannot see the
// draft either. Once the webview is gone, `draft.content` is the only copy,
// so a rejection still pending when the tab closes is reopened as an untitled
// Markdown document and the user is told.
//
// Scope of the guarantee: an ordinary tab close in a live window. Window close
// or reload is best effort — `onDidDispose` is a plain Event<void> that nothing
// awaits, so the host may be torn down before the untitled document opens.
// Two entry points share this helper: a rejection still pending at close
// (the panel's `onDidDispose`) and a stash the write-gate refuses when it
// drains AFTER dispose (host-session-core's post-dispose `parse-failed` arm,
// via the `rescueRejectedDraft` effect). They are mutually exclusive.
//
// The module takes its effects through `deps` and imports only types, so it
// stays unit-testable without a VS Code host (the panel supplies the real
// `workspace.openTextDocument` / `window.showWarningMessage` closures).

import type { MarkdownError } from "../../markdown/errors.js";

export interface RejectedDraftRescueDeps {
  /** Open `content` as an untitled Markdown text document and show it. */
  readonly openUntitled: (content: string) => Thenable<unknown>;
  /** One warning toast (fire-and-forget). */
  readonly showWarning: (message: string) => void;
}

/** The bytes the write-gate refused plus its reason. */
export interface RescuableDraft {
  readonly content: string;
  readonly error: MarkdownError;
}

// A throwing console must not skip the warning or leak an unhandled rejection
// from the discarded `.then()` below.
const logSafely = (...args: unknown[]): void => {
  try {
    console.error(...args);
  } catch {
    // Nothing left to report to.
  }
};

/** Rescue a rejected draft by reopening it as an untitled document. Always
 *  attempts — the caller decides whether a draft exists. Never throws; every
 *  failure is logged and surfaced as at most one warning toast. */
export function rescueRejectedDraft(
  draft: RescuableDraft,
  fsPath: string,
  deps: RejectedDraftRescueDeps
): void {
  const prefix = `Quoll could not save your last edit to ${fsPath} (${draft.error.message})`;
  const successMessage = `${prefix}. The unsaved draft is open in a new untitled document.`;
  // States only what was observed: `openUntitled` chains create + show, so a
  // failed show can leave the untitled document alive — never claim "lost".
  const failureMessage = `${prefix}, and could not reopen the unsaved draft.`;

  // A throwing toast is terminal: it is logged here and never re-classified as a
  // failed rescue, so it cannot become an unhandled rejection of the discarded
  // `.then()` result below nor trigger a second notice.
  const notify = (message: string): void => {
    try {
      deps.showWarning(message);
    } catch (err) {
      logSafely("[quoll] rejected-draft rescue notice failed", err);
    }
  };
  const failed = (err: unknown): void => {
    logSafely("[quoll] rejected-draft rescue failed", err);
    notify(failureMessage);
  };

  let opened: Thenable<unknown>;
  try {
    opened = deps.openUntitled(draft.content);
  } catch (err) {
    failed(err);
    return;
  }
  void opened.then(() => notify(successMessage), failed);
}
