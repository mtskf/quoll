// `quoll.format` command + active-panel forwarding.
//
// VS Code forwards EVERY webview keydown to the workbench keybinding service
// (handleInnerKeydown, webview/browser/pre/index.html) regardless of
// preventDefault, so a webview-only keymap would double-fire globally-bound
// chords (Cmd+B toggles the sidebar, Cmd+Shift+X opens Extensions, Cmd+K starts
// a chord). Instead package.json binds those chords, scoped to
// `activeCustomEditorId == 'quoll.editMarkdown'`, to this single command — a
// more-specific `when` clause overrides the unscoped workbench default (standard
// VS Code keybinding precedence; toggle-editor.ts:15-20 reasons about such a
// binding double-firing with a webview handler, which confirms it fires during
// webview focus). The command forwards the action to the ACTIVE panel's webview,
// which runs the actual CodeMirror transaction. No document mutation happens here.
//
// Only the five keybindings ever supply `args`, so package.json also hides this
// command from the Command Palette (menus.commandPalette, when: "false") — a
// palette invocation can never carry an argument and would be meaningless.
// See runFormatCommand() for the remaining reachable no-argument paths (e.g. a
// user's own keybindings.json) and how they now report themselves instead of
// silently no-op'ing.
//
// The active poster is set/cleared by the panel on its active edge (a custom
// editor provider hands out no registry, so the active panel registers itself).

import { commands, type Disposable, window } from "vscode";
import { FORMAT_ACTIONS, type FormatAction } from "../../shared/protocol.js";
import { showSafely } from "../surface/show-safely.js";
import { createActivePoster } from "./active-poster.js";

export type FormatPoster = (action: FormatAction) => void;

// Both the guard below and the toast's "one of …" list read the protocol's
// FORMAT_ACTIONS directly, so this command can never know a different action set
// than the wire does — the drift that let a valid action be rejected here as
// unknown is now unrepresentable rather than merely tested for.
function isFormatAction(value: unknown): value is FormatAction {
  return typeof value === "string" && (FORMAT_ACTIONS as readonly string[]).includes(value);
}

// Identity-guarded single-slot latch (see active-poster.ts): a panel losing
// focus after another already became active must not wipe the new poster.
const registry = createActivePoster<FormatPoster>();

export function setActiveFormatPoster(poster: FormatPoster): void {
  registry.set(poster);
}

export function clearActiveFormatPoster(poster: FormatPoster): void {
  registry.clear(poster);
}

export function normalizeFormatAction(arg: unknown): FormatAction | null {
  return isFormatAction(arg) ? arg : null;
}

/** Command body, exported as the unit-test seam (the registration itself needs
 *  a live host). Both failure arms used to fall off the end of the handler with
 *  no post, no log and no toast, which is indistinguishable from "the chord
 *  never reached the extension" — every silent exit now says what to do. */
export function runFormatCommand(arg: unknown): void {
  const action = normalizeFormatAction(arg);
  if (action === null) {
    // Split on what the user can act on, which is whether they typed an action
    // at all: a misspelt one gets quoted back, while anything that is not a
    // string (`args` omitted, or hand-edited to null / a number / a nested
    // object) is the same "you still owe us an action" mistake — and naming
    // those with String() would only ever print "[object Object]".
    // (The Command Palette can reach neither — package.json hides this command
    // there, since a palette invocation can never supply an argument.)
    const detail =
      typeof arg === "string"
        ? `"${arg}" is not a recognized action`
        : "this command needs a string action argument";
    showSafely(
      window.showInformationMessage(`Quoll: ${detail} — one of ${FORMAT_ACTIONS.join(", ")}.`),
      "showInformationMessage"
    );
    return;
  }
  const post = registry.get();
  if (post === null) {
    showSafely(
      window.showInformationMessage(
        "Quoll: open a Markdown file in the Quoll editor to format a selection."
      ),
      "showInformationMessage"
    );
    return;
  }
  post(action);
}

export function registerFormatCommand(): Disposable {
  return commands.registerCommand("quoll.format", runFormatCommand);
}

/** Test seam — do not use in production code. */
export function __getActivePosterForTest(): FormatPoster | null {
  return registry.get();
}
