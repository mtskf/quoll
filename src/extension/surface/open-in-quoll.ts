// Open a resource with the Quoll custom editor.
//
// Isolated in its own module (imports only `commands`) so the load-bearing
// contract — the `vscode.openWith` command id — is unit-testable under the
// vscode stub without dragging in QuollEditorPanel. Mirrors the sibling
// reopen-text-editor.ts adapter (which owns the "default" text-editor path);
// keeping BOTH openWith call sites behind a thin, tested adapter is the
// established pattern for pinning VS Code command contracts here.
//
// The viewType is a PARAMETER (not hard-coded) so the single source of truth
// stays QuollEditorPanel.viewType — the caller passes it in.

import { commands, type Uri } from "vscode";

/** Open `uri` with the Quoll editor via `vscode.openWith`. `viewType` is the
 *  caller's `QuollEditorPanel.viewType`. `exec` is seamed for unit tests;
 *  production uses `commands.executeCommand`. Returns the underlying Thenable so
 *  callers can attach a rejection handler. */
export function openInQuollEditor(
  uri: Uri,
  viewType: string,
  exec: (command: string, ...rest: unknown[]) => Thenable<unknown> = commands.executeCommand
): Thenable<unknown> {
  return exec("vscode.openWith", uri, viewType);
}
