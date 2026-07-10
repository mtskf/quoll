import { commands, type ExtensionContext, ExtensionMode, window, workspace } from "vscode";
import { canEditWith } from "./can-edit-with.js";
import { QuollEditorPanel } from "./quoll-editor-panel.js";
import { showSafely } from "./show-safely.js";
import { __clearSurfaceMemoryForTest } from "./surface-memory.js";
import { registerSurfaceRestoreWatcher } from "./surface-restore-watcher.js";
import { registerToggleEditor } from "./toggle-editor.js";

export async function activate(context: ExtensionContext) {
  // Dynamic import so esbuild tree-shakes the TestHarness class body out
  // of the production bundle. A static `import { TestHarness }` keeps the
  // ~250 LOC of waiter machinery in `dist/extension.cjs` for every
  // Marketplace user even though the runtime gate prevents instantiation.
  const harness =
    context.extensionMode === ExtensionMode.Test
      ? new (await import("./test-harness.js")).TestHarness()
      : undefined;
  if (harness) {
    // Inject THIS bundle's surface-memory clear so the harness `reset()`
    // (per-test cleanup) empties the map the restore watcher actually reads.
    // test-harness.js is a separate esbuild bundle, so it cannot import
    // surface-memory itself without cloning the map. Test mode only.
    harness.surfaceMemoryReset = __clearSurfaceMemoryForTest;
  }

  context.subscriptions.push(QuollEditorPanel.register(context, harness));
  context.subscriptions.push(registerToggleEditor());
  context.subscriptions.push(registerSurfaceRestoreWatcher(QuollEditorPanel.viewType));
  context.subscriptions.push(
    commands.registerCommand("quoll.editWith", async () => {
      const editor = window.activeTextEditor;
      if (!editor) {
        // Silent no-op left users wondering whether the keybinding /
        // palette invocation registered at all. Tell them what to do.
        showSafely(
          window.showInformationMessage("Open a Markdown file in the editor first to use Quoll."),
          "showInformationMessage"
        );
        return;
      }
      const decision = canEditWith(editor.document, (scheme) =>
        workspace.fs.isWritableFileSystem(scheme)
      );
      if (!decision.ok) {
        // showWarningMessage's Thenable can reject (host detached, dispatcher
        // torn down); showSafely logs instead of letting it become an
        // unhandled rejection. See show-safely.ts for the shared rationale.
        showSafely(window.showWarningMessage(decision.reason), "showWarningMessage");
        return;
      }
      try {
        await commands.executeCommand(
          "vscode.openWith",
          editor.document.uri,
          QuollEditorPanel.viewType
        );
      } catch (err: unknown) {
        // vscode.openWith rejection bubbled to the dispatcher previously,
        // surfacing as a generic "Command failed" toast with no Quoll
        // context. Catch and re-surface with a Quoll-prefixed message so
        // triage can attribute the failure.
        console.error("[quoll] vscode.openWith rejected", err);
        showSafely(
          window.showErrorMessage(
            `Quoll could not open this file: ${err instanceof Error ? err.message : String(err)}`
          ),
          "showErrorMessage"
        );
      }
    })
  );

  return harness ? { __test: { harness } } : undefined;
}
