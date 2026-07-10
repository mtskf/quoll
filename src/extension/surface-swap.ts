// In-place editor-surface swap for ⌘⌥E (Quoll rich editor ↔ built-in text
// editor). vscode.openWith opens the TARGET as a second tab beside the source
// and never replaces it (E2E-probed 2026-07-10), so the source tab must be
// closed explicitly. Closing a DIRTY source tab reverts the shared working copy
// (CustomEditorInput.matches gap — memory quoll-custom-editor-close-reverts-shared-doc)
// and pops a save dialog, so we SAVE first (user-approved save-then-swap): a
// clean tab closes with no revert and no dialog. If the doc can't be made clean
// we DO NOT close (both-open, never data loss).

/** Safety gate: close the source tab only when there is one AND the document is
 *  provably clean — either it was already clean, or it was dirty and the save
 *  succeeded and it is no longer dirty. Any other dirty state means the close
 *  would revert the shared working copy, so refuse (degrade to both-open). */
export function shouldCloseSourceTab(state: {
  hasSourceTab: boolean;
  wasDirty: boolean;
  saveSucceeded: boolean;
  stillDirtyAfterSave: boolean;
}): boolean {
  if (!state.hasSourceTab) {
    return false;
  }
  if (!state.wasDirty) {
    return true;
  }
  return state.saveSucceeded && !state.stillDirtyAfterSave;
}
