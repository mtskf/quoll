// Reopen a resource in VS Code's built-in (default) text editor.
//
// Isolated in its own module (imports only `commands`) so the load-bearing
// contract — the exact `vscode.openWith` command id + the "default" viewType —
// is unit-testable under the vscode stub without dragging in QuollEditorPanel /
// the Tabs API.

import { commands, type Uri } from "vscode";

/** VS Code's built-in text-editor viewType for `vscode.openWith`. Opening a
 *  resource with this viewType opens/reveals the built-in text editor as a
 *  SEPARATE tab beside any existing editor of the resource — it does NOT replace
 *  a Quoll custom tab (E2E-probed 2026-07-10). The in-place swap closes the
 *  source tab separately (see surface-swap.ts). A stable VS Code contract. */
export const DEFAULT_TEXT_EDITOR_VIEW_TYPE = "default";

/** Reopen `uri` in the built-in text editor. `exec` is seamed for unit tests;
 *  production uses `commands.executeCommand`. Returns the underlying Thenable so
 *  callers can await / attach a rejection handler. */
export function openInTextEditor(
  uri: Uri,
  exec: (command: string, ...rest: unknown[]) => Thenable<unknown> = commands.executeCommand
): Thenable<unknown> {
  return exec("vscode.openWith", uri, DEFAULT_TEXT_EDITOR_VIEW_TYPE);
}
