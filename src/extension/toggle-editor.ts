// `quoll.toggleEditor` — swap the active `.md` between Quoll and the built-in
// text editor. Direction is classified from the ACTIVE TAB (Tabs API, stable
// since 1.67) and the active text editor — stateless, no per-panel tracking:
//   - Active tab is the Quoll custom editor  → forward: reopen in the text editor.
//   - Otherwise a markdown text editor is active → reverse: validate with
//     canEditWith, stash its caret, then open Quoll via vscode.openWith directly
//     (NOT delegated to quoll.editWith, so a swallowed rejection cannot orphan
//     the stash — the catch cleans it up).
//   - Anything else (diff editor, non-markdown, non-text tab) → a friendly no-op
//     notification (do NOT blindly open Quoll).
//
// Not a "No-dual-editor" violation: forward drives VS Code's NATIVE text editor
// (vscode.openWith … "default"); a convenience affordance, not a second runtime.
//
// NOTE (keybindings): the Quoll→text chord (⌘⌥E / Ctrl+Alt+E) is a raw keydown
// handler in src/webview/cm/switch-editor.ts, matched on the physical
// `event.code` — NOT a package.json keybinding. A forward workbench keybinding
// scoped to `activeCustomEditorId` would double-fire with that handler and can
// bounce the switch. package.json binds the chord to this command ONLY in the
// text-editor (reverse) context.

import { commands, TabInputCustom, TabInputText, window, workspace } from "vscode";
import { canEditWith } from "./can-edit-with.js";
import { stashSwitchCaret, takeSwitchCaret } from "./editor-switch-caret.js";
import { QuollEditorPanel } from "./quoll-editor-panel.js";
import { openInTextEditor } from "./reopen-text-editor.js";

export type SwitchTarget = "to-text" | "to-quoll" | "none";

/** Pure direction decision. Forward (Quoll active) takes priority over reverse.
 *  `activeMarkdownUriKey` is the active text editor's `Uri.toString()` when it is
 *  a markdown document, else null. */
export function decideSwitchTarget(ctx: {
  onQuollTab: boolean;
  activeMarkdownUriKey: string | null;
}): SwitchTarget {
  if (ctx.onQuollTab) {
    return "to-text";
  }
  if (ctx.activeMarkdownUriKey !== null) {
    return "to-quoll";
  }
  return "none";
}

function isMarkdownUri(uri: { path: string }): boolean {
  return uri.path.toLowerCase().endsWith(".md");
}

function surfaceError(prefix: string, err: unknown): void {
  console.error(`[quoll] ${prefix}`, err);
  void window
    .showErrorMessage(`Quoll: ${prefix}: ${err instanceof Error ? err.message : String(err)}`)
    .then(undefined, (e: unknown) => console.error("[quoll] showErrorMessage rejected", e));
}

export function registerToggleEditor(): { dispose(): void } {
  return commands.registerCommand("quoll.toggleEditor", async () => {
    const input = window.tabGroups.activeTabGroup.activeTab?.input;
    const onQuollTab =
      input instanceof TabInputCustom && input.viewType === QuollEditorPanel.viewType;
    const activeEditor = window.activeTextEditor;
    // Reverse requires the ACTIVE TAB to be a plain text editor (TabInputText —
    // a diff tab is TabInputTextDiff, excluded) for a markdown file, AND the
    // active text editor to be that same document. Gating on the tab input (not
    // window.activeTextEditor alone) keeps a markdown diff side from being
    // mis-toggled into Quoll (the "diff editor → no-op" contract above).
    const reverseEditor =
      !onQuollTab &&
      input instanceof TabInputText &&
      activeEditor !== undefined &&
      activeEditor.document.uri.toString() === input.uri.toString() &&
      isMarkdownUri(activeEditor.document.uri)
        ? activeEditor
        : null;
    const activeMarkdownUriKey = reverseEditor ? reverseEditor.document.uri.toString() : null;

    const target = decideSwitchTarget({ onQuollTab, activeMarkdownUriKey });
    switch (target) {
      case "to-text": {
        // Re-narrow for the type system (decideSwitchTarget's boolean hides the
        // instanceof from TS) — and a cheap guard should a future refactor ever
        // decouple `onQuollTab` from this check. This is the Command-Palette
        // forward path (Quoll active, no live activeTextEditor caret to read
        // here); it does NOT restore the caret — the caret-preserving forward
        // affordances are the top-right button + the ⌘⌥E / Ctrl+Alt+E chord,
        // which post `switch-to-text` to the panel (owns lastKnownCaret, re-applies
        // it — Task 5). A rare, acceptable gap.
        if (!(input instanceof TabInputCustom)) {
          return;
        }
        const uri = input.uri;
        // Observability for the documented caret non-preservation on this path.
        console.info(
          "[quoll] palette forward: caret not preserved (use the button or ⌘⌥E / Ctrl+Alt+E)"
        );
        try {
          await openInTextEditor(uri);
        } catch (err) {
          surfaceError("could not open the text editor", err);
        }
        return;
      }
      case "to-quoll": {
        // activeEditor is a markdown editor here (activeMarkdownUriKey !== null).
        if (reverseEditor === null) {
          return; // unreachable when target is "to-quoll", but narrows for TS
        }
        const editor = reverseEditor;
        // Validate BEFORE stashing: canEditWith may reject (non-file / readonly)
        // in which case NO Quoll panel is created and `takeSwitchCaret` would
        // never fire — a stashed caret would then leak and mis-apply on a later
        // normal open. Validate first, stash only when Quoll will actually open.
        const decision = canEditWith(editor.document, (scheme) =>
          workspace.fs.isWritableFileSystem(scheme)
        );
        if (!decision.ok) {
          void window
            .showWarningMessage(decision.reason)
            .then(undefined, (e: unknown) =>
              console.error("[quoll] showWarningMessage rejected", e)
            );
          return;
        }
        const key = editor.document.uri.toString();
        const active = editor.selection.active;
        stashSwitchCaret(key, { line: active.line, character: active.character });
        try {
          // Open Quoll directly (validation already done above). The fresh panel
          // takes the stashed caret at `ready` (Task 5). NOT delegated to
          // `quoll.editWith` so a swallowed rejection cannot leave the stash
          // orphaned and un-toasted.
          await commands.executeCommand(
            "vscode.openWith",
            editor.document.uri,
            QuollEditorPanel.viewType
          );
        } catch (err) {
          takeSwitchCaret(key); // clear the stash so it does not apply on a later open
          surfaceError("could not open the rich editor", err);
        }
        return;
      }
      case "none":
        void window
          .showInformationMessage(
            "Quoll: open a Markdown file to toggle between the rich and text editors."
          )
          .then(undefined, (e: unknown) =>
            console.error("[quoll] showInformationMessage rejected", e)
          );
        return;
      default: {
        // Exhaustiveness guard — a new SwitchTarget without a case reds tsc,
        // mirroring the closed-union guards in QuollEditorPanel.handleInbound
        // and shell.ts rather than silently falling through to a notification.
        const _exhaustive: never = target;
        void _exhaustive;
        return;
      }
    }
  });
}
