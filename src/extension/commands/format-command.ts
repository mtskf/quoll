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
// The active poster is set/cleared by the panel on its active edge (a custom
// editor provider hands out no registry, so the active panel registers itself).

import { commands, type Disposable } from "vscode";
import type { FormatCommandMessage } from "../../shared/protocol.js";

export type FormatAction = FormatCommandMessage["action"];
export type FormatPoster = (action: FormatAction) => void;

const KNOWN: ReadonlySet<string> = new Set(["bold", "italic", "code", "strike", "link"]);

let activePoster: FormatPoster | null = null;

export function setActiveFormatPoster(poster: FormatPoster): void {
  activePoster = poster;
}

/** Clear only if `poster` is still the active one — a panel losing focus after
 *  another already became active must not wipe the new poster. */
export function clearActiveFormatPoster(poster: FormatPoster): void {
  if (activePoster === poster) {
    activePoster = null;
  }
}

export function normalizeFormatAction(arg: unknown): FormatAction | null {
  return typeof arg === "string" && KNOWN.has(arg) ? (arg as FormatAction) : null;
}

export function registerFormatCommand(): Disposable {
  return commands.registerCommand("quoll.format", (arg: unknown) => {
    const action = normalizeFormatAction(arg);
    if (action !== null) {
      activePoster?.(action);
    }
  });
}

/** Test seam — do not use in production code. */
export function __getActivePosterForTest(): FormatPoster | null {
  return activePoster;
}
