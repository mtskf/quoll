import { commands, type ExtensionContext, ExtensionMode, window } from "vscode";
import { registerFormatCommand } from "./format-command.js";
import { QuollEditorPanel } from "./quoll-editor-panel.js";
import { showSafely } from "./show-safely.js";
import { __clearSurfaceMemoryForTest } from "./surface-memory.js";
import { registerSurfaceRestoreWatcher } from "./surface-restore-watcher.js";
import {
  registerToggleEditor,
  reopenActiveQuollTabAsText,
  reopenTextEditorAsQuoll,
} from "./toggle-editor.js";

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
  // Title-bar "Reopen in Text Editor" (file-code icon) — the Quoll→text half of
  // the Rich ↔ Text switch, driving the same swap path as quoll.toggleEditor's
  // to-text case. The other direction (cat icon → Quoll, quoll.editWith below)
  // drives the shared reopenTextEditorAsQuoll helper so both swap in place.
  context.subscriptions.push(
    commands.registerCommand("quoll.reopenInTextEditor", reopenActiveQuollTabAsText)
  );
  context.subscriptions.push(registerFormatCommand());
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
      // Drive the shared in-place swap (validate → open Quoll → close the source
      // text tab). Pre-fix this ran a raw vscode.openWith with no source-tab
      // close, so the cat button opened a SECOND tab beside the source instead of
      // swapping in place. The helper owns validation, the openWith, the
      // save-then-close, and error surfacing — symmetric with quoll.toggleEditor.
      await reopenTextEditorAsQuoll(editor);
    })
  );

  return harness ? { __test: { harness } } : undefined;
}
