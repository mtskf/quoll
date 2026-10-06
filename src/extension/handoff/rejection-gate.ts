// Shared pending-rejection gate for the two AI context handoffs (Claude Code
// tier-0 delegation + Codex whole-file add). While the host session holds a
// pending write-gate rejection the user's draft lives ONLY webview-side, so the
// document either handoff would reference is not what the user sees — handing it
// off and reporting success would be a false success. Both pure handlers take
// these two deps and call refusedForRejection at entry and after each await
// INSIDE THE ABORTABLE RANGE (the awaits that precede the handoff's first
// irreversible external effect). After the Claude insert command has resolved
// only the bare predicate is read (a silent skip of the insurance clipboard
// write, never a notice); after the fallback clipboard write has started
// nothing is re-checked.

export type RejectionGateDeps = {
  /** True while the host session holds a pending write-gate rejection. A bare
   *  predicate (no side effect), so the Claude handler can also read it directly
   *  for its notice-free skip — when each read happens is in the header above. */
  isRejectionPending: () => boolean;
  /** Surface the one refusal notice. Total (never throws) — the wiring binds it
   *  to the panel's showError. */
  showRejectionBlocked: () => void;
};

/** True (after surfacing the single refusal notice) when a write-gate rejection
 *  is pending. A rejection can land during ANY await (the webview keeps posting
 *  edits), and the edit-settled barrier only orders a handoff against the write
 *  LOCK — a rejected Edit never takes the lock — so callers re-check after every
 *  await inside the abortable range, not just at entry. */
export function refusedForRejection(deps: RejectionGateDeps): boolean {
  if (!deps.isRejectionPending()) {
    return false;
  }
  deps.showRejectionBlocked();
  return true;
}
