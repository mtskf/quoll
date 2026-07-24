// Cross-surface pending-rejection registry.
//
// The in-webview switch-to-text arm (quoll-editor-panel.ts) refuses a forward
// surface swap while a write-gate rejection is pending by reading its own host
// session's `state.rejection` directly: closing the Quoll tab then would orphan
// the draft, which lives ONLY webview-side (disk clean, banner up, CodeMirror
// never reseeded).
//
// The COMMAND path to the same swap — the title-bar `quoll.reopenInTextEditor`
// button and `quoll.toggleEditor`'s to-text case, both via
// reopenActiveQuollTabAsText in toggle-editor.ts — is TAB-ONLY: it classifies
// the active tab and drives finalizeSurfaceSwap with no panel closure, so it
// cannot see `state.rejection`. This registry is the seam. Each live panel
// publishes a predicate reporting whether ITS session currently holds a pending
// rejection, keyed by `document.uri.toString()`; the command path reads it and
// refuses symmetrically with the webview arm.
//
// It carries NO webview bytes across the boundary — only a boolean predicate —
// so it does not weaken the write-gate's authority (ARCHITECTURE.md §6: the
// rejected draft is blocked-and-resurfaced, never trusted past the gate) and it
// does not introduce a second editor (No-dual-editor guardrail): the swap still
// drives VS Code's native text editor, this only decides whether to refuse it.
//
// supportsMultipleEditorsPerDocument is false, so at most one panel is registered
// per uri at a time. Registration returns an identity-safe disposable: it removes
// the entry only if it is still the one this registration installed, so a panel
// re-resolve (old panel disposes AFTER the new one registered on the same uri)
// cannot delete the live panel's predicate. A missing entry reads as "no
// rejection" (false) — the safe default that leaves the swap unblocked.

/** User-facing message shown when a forward Quoll→text swap is refused because a
 *  write-gate rejection is pending. Shared by BOTH forward entry points — the
 *  command path (reopenActiveQuollTabAsText) and the in-webview switch-to-text arm
 *  (quoll-editor-panel.ts) — so every refusal reads identically. */
export const REJECTION_BLOCKS_SWITCH_MESSAGE =
  "Quoll: can't switch to the text editor while a change can't be saved — resolve the highlighted problem first.";

const pendingRejectionByUri = new Map<string, () => boolean>();

/** Publish `isPending` for `uriKey`. The panel MUST call the returned
 *  disposable on dispose; it is identity-safe against a same-uri re-resolve. */
export function registerPendingRejection(
  uriKey: string,
  isPending: () => boolean
): { dispose(): void } {
  pendingRejectionByUri.set(uriKey, isPending);
  return {
    dispose(): void {
      if (pendingRejectionByUri.get(uriKey) === isPending) {
        pendingRejectionByUri.delete(uriKey);
      }
    },
  };
}

/** True iff a panel for `uriKey` is registered AND its session currently holds a
 *  pending write-gate rejection. Absent registration ⇒ false (swap unblocked). */
export function isRejectionPending(uriKey: string): boolean {
  return pendingRejectionByUri.get(uriKey)?.() ?? false;
}
