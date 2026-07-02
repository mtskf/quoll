// Reopen a resource in VS Code's built-in (default) text editor.
//
// Isolated in its own module (imports only `commands`) so the load-bearing
// contract — the exact `vscode.openWith` command id + the "default" viewType —
// is unit-testable under the vscode stub without dragging in QuollEditorPanel /
// the Tabs API.

import { commands, type Uri } from "vscode";

/** VS Code's built-in text-editor viewType for `vscode.openWith`. Reopening a
 *  resource with this viewType swaps the current editor for the default text
 *  editor in the same group — the native "Reopen Editor With… → Text Editor"
 *  path. A stable VS Code contract, not a Quoll construct. */
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
