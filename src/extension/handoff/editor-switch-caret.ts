// One-shot per-uri caret handoff for the text-editor → Quoll switch.
//
// `vscode.openWith` opens Quoll as a SEPARATE tab beside the text editor — it
// does NOT replace it in place (E2E-probed 2026-07-10; the in-place swap closes
// the source tab separately, see surface-swap.ts). Either way, switching a text
// editor back to Quoll creates a FRESH QuollEditorPanel whose per-panel
// `lastKnownCaret` starts null, so the existing caret handoff (which spans two
// *live* editors on the same doc) cannot carry the caret across this boundary. The `quoll.toggleEditor` command
// stashes the text editor's caret here just before reopening in Quoll; the new
// panel takes it at `ready` and applies it once via a `caret-apply` message.
//
// Module-level Map (not per-panel) precisely because the source panel does not
// exist yet when the destination panel reads. `take` removes the entry so a
// later webview reload does not re-apply a stale switch caret. Bounded: at most
// one entry per uri, cleared on read; a switch that never lands (user cancels)
// leaves one small stale entry that the next real switch overwrites.

import type { Caret } from "./caret-handoff.js";

const pending = new Map<string, Caret>();

/** Stash the caret for `uriKey` (a `Uri.toString()`), overwriting any prior. */
export function stashSwitchCaret(uriKey: string, caret: Caret): void {
  pending.set(uriKey, caret);
}

/** Take (return AND remove) the stashed caret for `uriKey`, or null if none. */
export function takeSwitchCaret(uriKey: string): Caret | null {
  const caret = pending.get(uriKey) ?? null;
  pending.delete(uriKey);
  return caret;
}
