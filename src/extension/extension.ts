import { commands, type ExtensionContext, ExtensionMode, window, workspace } from "vscode";
import { canEditWith } from "./canEditWith.js";
import { QuollEditorPanel } from "./QuollEditorPanel.js";

export async function activate(context: ExtensionContext) {
  // Dynamic import so esbuild tree-shakes the TestHarness class body out
  // of the production bundle. A static `import { TestHarness }` keeps the
  // ~250 LOC of waiter machinery in `dist/extension.cjs` for every
  // Marketplace user even though the runtime gate prevents instantiation.
  const harness =
    context.extensionMode === ExtensionMode.Test
      ? new (await import("./test-harness.js")).TestHarness()
      : undefined;

  context.subscriptions.push(QuollEditorPanel.register(context, harness));
  context.subscriptions.push(
    commands.registerCommand("quoll.editWith", async () => {
      const editor = window.activeTextEditor;
      if (!editor) {
        // Silent no-op left users wondering whether the keybinding /
        // palette invocation registered at all. Tell them what to do.
        void window
          .showInformationMessage("Open a Markdown file in the editor first to use Quoll.")
          .then(undefined, (err: unknown) => {
            console.error("[quoll] showInformationMessage rejected", err);
          });
        return;
      }
      const decision = canEditWith(editor.document, (scheme) =>
        workspace.fs.isWritableFileSystem(scheme)
      );
      if (!decision.ok) {
        // showWarningMessage returns a Thenable that can reject (host
        // detached, dispatcher torn down). QuollEditorPanel's showError
        // helper closes the same asymmetry; mirror it here so activation
        // code does not silently swallow rejection.
        void window.showWarningMessage(decision.reason).then(undefined, (err: unknown) => {
          console.error("[quoll] showWarningMessage rejected", err);
        });
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
        void window
          .showErrorMessage(
            `Quoll could not open this file: ${err instanceof Error ? err.message : String(err)}`
          )
          .then(undefined, (err: unknown) => {
            console.error("[quoll] showErrorMessage rejected", err);
          });
      }
    })
  );

  return harness ? { __test: { harness } } : undefined;
}
