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
import type { FormatCommandMessage } from "../../shared/protocol.js";
import { showSafely } from "../surface/show-safely.js";
import { createActivePoster } from "./active-poster.js";

export type FormatAction = FormatCommandMessage["action"];
export type FormatPoster = (action: FormatAction) => void;

// `satisfies` pins one direction only: every entry here IS a FormatAction, so a
// typo fails `pnpm compile` instead of becoming a silently-unreachable action.
// It does NOT pin the other direction — a sixth action added to FormatAction in
// protocol.ts and forgotten here still compiles (tracked separately; deriving
// the list from one shared source is the real fix).
const KNOWN_ACTIONS = [
  "bold",
  "italic",
  "code",
  "strike",
  "link",
] as const satisfies readonly FormatAction[];

function isFormatAction(value: unknown): value is FormatAction {
  return typeof value === "string" && (KNOWN_ACTIONS as readonly string[]).includes(value);
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
    // Two different mistakes, two different fixes: a hand-written keybinding
    // with no `args` at all vs. one carrying a misspelt/unsupported action.
    // (The Command Palette can reach neither — package.json hides this command
    // there, since a palette invocation can never supply an argument.)
    const detail =
      arg === undefined
        ? "this command needs an action argument"
        : `"${String(arg)}" is not a recognized action`;
    showSafely(
      window.showInformationMessage(`Quoll: ${detail} — one of ${KNOWN_ACTIONS.join(", ")}.`),
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
