// `quoll.toggleEditor` — swap the active `.md` between Quoll and the built-in
// text editor. Direction is classified from the ACTIVE TAB (Tabs API, stable
// since 1.67) and the active text editor — stateless, no per-panel tracking:
//   - Active tab is the Quoll custom editor  → forward: reopen in the text editor.
//   - Otherwise a markdown text editor is active → reverse: validate with
//     canEditWith, stash its caret, then open Quoll IN PLACE via the shared
//     `reopenTextEditorAsQuoll` helper (findSourceTab + finalizeSurfaceSwap —
//     the same helper the title-bar cat button `quoll.editWith` drives, so both
//     directions share ONE swap path; the helper owns the catch that clears the
//     stash so a swallowed rejection cannot orphan it).
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

import { commands, TabInputCustom, TabInputText, type TextEditor, window, workspace } from "vscode";
import { canEditWith } from "./can-edit-with.js";
import { stashSwitchCaret, takeSwitchCaret } from "./editor-switch-caret.js";
import { openInTextEditor } from "./reopen-text-editor.js";
import { QuollEditorPanel } from "./session/quoll-editor-panel.js";
import { showSafely } from "./show-safely.js";
import { noteSurface } from "./surface-memory.js";
import { finalizeSurfaceSwap, findSourceTab } from "./surface-swap.js";

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
  showSafely(
    window.showErrorMessage(
      `Quoll: ${prefix}: ${err instanceof Error ? err.message : String(err)}`
    ),
    "showErrorMessage"
  );
}

/** Forward swap: reopen the active Quoll custom tab in the built-in text editor,
 *  then close the Quoll source tab (save-then-swap; see surface-swap.ts). No-op
 *  if the active tab is not a Quoll custom tab. Caret is NOT preserved on this
 *  path — the caret-preserving forward affordances are the in-editor button + the
 *  ⌘⌥E / Ctrl+Alt+E chord (they post `switch-to-text` to the panel, which owns
 *  lastKnownCaret). Shared by `quoll.toggleEditor` (to-text case) and the
 *  title-bar `quoll.reopenInTextEditor` button so both directions drive one swap
 *  path — no duplicated surface-swap logic. */
export async function reopenActiveQuollTabAsText(): Promise<void> {
  const input = window.tabGroups.activeTabGroup.activeTab?.input;
  if (!(input instanceof TabInputCustom) || input.viewType !== QuollEditorPanel.viewType) {
    return;
  }
  const uri = input.uri;
  const sourceTab = findSourceTab(uri.toString(), "quoll", QuollEditorPanel.viewType);
  // Observability for the documented caret non-preservation on this path.
  console.info(
    "[quoll] forward: caret not preserved (use the in-editor button or ⌘⌥E / Ctrl+Alt+E)"
  );
  try {
    await openInTextEditor(uri);
    // Record intent AFTER the open succeeds and BEFORE the source close, so the
    // surface-restore watcher adopts "text" instead of bouncing this deliberate
    // swap (and a failed open records nothing).
    noteSurface(uri.toString(), "text");
    await finalizeSurfaceSwap(uri, sourceTab);
  } catch (err) {
    surfaceError("could not open the text editor", err);
  }
}

/** Reverse swap: open a markdown text editor as Quoll IN PLACE, closing the
 *  source text tab (save-then-swap; see surface-swap.ts). Shared by
 *  `quoll.toggleEditor`'s to-quoll case and the title-bar `quoll.editWith` (cat
 *  icon) button so both directions drive ONE swap path — no duplicated
 *  surface-swap logic, and the cat button no longer opens a second tab.
 *
 *  Order is load-bearing (do NOT reorder): validate → findSourceTab (captured
 *  BEFORE openWith per surface-swap.ts:findSourceTab) → stash caret (AFTER
 *  validate, so a rejected validate cannot orphan a stash) → openWith →
 *  noteSurface → finalizeSurfaceSwap. On open failure the caret stash is cleared
 *  so it cannot mis-apply on a later normal open. `editor` must be a markdown
 *  text editor; canEditWith re-checks scheme/readonly and warns + no-ops if not. */
export async function reopenTextEditorAsQuoll(editor: TextEditor): Promise<void> {
  const decision = canEditWith(editor.document, (scheme) =>
    workspace.fs.isWritableFileSystem(scheme)
  );
  if (!decision.ok) {
    showSafely(window.showWarningMessage(decision.reason), "showWarningMessage");
    return;
  }
  const key = editor.document.uri.toString();
  const sourceTab = findSourceTab(key, "text", QuollEditorPanel.viewType);
  const active = editor.selection.active;
  stashSwitchCaret(key, { line: active.line, character: active.character });
  try {
    // Open Quoll directly (validation already done above). The fresh panel takes
    // the stashed caret at `ready`. NOT delegated to the `quoll.editWith` command
    // so a swallowed rejection cannot leave the stash orphaned and un-toasted.
    await commands.executeCommand(
      "vscode.openWith",
      editor.document.uri,
      QuollEditorPanel.viewType
    );
    // Record intent AFTER the open succeeds and BEFORE the source close, so the
    // surface-restore watcher adopts "quoll" instead of bouncing this deliberate
    // swap (and a failed open records nothing).
    noteSurface(key, "quoll");
    await finalizeSurfaceSwap(editor.document.uri, sourceTab);
  } catch (err) {
    takeSwitchCaret(key); // clear the stash so it does not apply on a later open
    surfaceError("could not open the rich editor", err);
  }
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
        // The active tab is the Quoll custom editor here (onQuollTab). Delegate
        // to the shared forward-swap helper — also the title-bar
        // `quoll.reopenInTextEditor` handler — so both drive one swap path. This
        // is the Command-Palette forward entry; caret is not preserved (a rare,
        // acceptable gap — see reopenActiveQuollTabAsText).
        await reopenActiveQuollTabAsText();
        return;
      }
      case "to-quoll": {
        // activeEditor is a markdown editor here (activeMarkdownUriKey !== null).
        if (reverseEditor === null) {
          return; // unreachable when target is "to-quoll", but narrows for TS
        }
        // Delegate to the shared reverse-swap helper — also the title-bar
        // `quoll.editWith` (cat) handler — so both drive one in-place swap path.
        await reopenTextEditorAsQuoll(reverseEditor);
        return;
      }
      case "none":
        showSafely(
          window.showInformationMessage(
            "Quoll: open a Markdown file to toggle between the rich and text editors."
          ),
          "showInformationMessage"
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
