// Host-owned status-bar parity for an active Quoll editor. A custom editor is
// not a `TextEditor`, so `window.activeTextEditor` is undefined and VS Code
// drops ALL of its built-in status-bar items (cursor position, EOL, language,
// encoding, indentation). This reintroduces the subset whose data already
// flows to the host: cursor position (`Ln X, Col Y`), EOL (`LF`/`CRLF`), and a
// static language indicator.
//
// OUT of scope on purpose: encoding (no public VS Code API reads a document's
// encoding — the built-in indicator is internal) and indentation (no
// `TextEditor.options` for a custom editor). Selection count is a follow-up
// (needs the selection anchor on the `caret-report` wire, currently head-only).
//
// Pure of VS Code: the formatters take primitives and the controller drives an
// injected `StatusBarSlot` interface, so the whole module unit-tests without a
// live host (the real `vscode.StatusBarItem` satisfies `StatusBarSlot`
// structurally). The panel is the single place that calls
// `window.createStatusBarItem` and feeds the live document in.

import type { Caret } from "./caret-handoff.js";

// vscode.EndOfLine: LF = 1, CRLF = 2. Mirrored as a literal so this module
// stays vscode-free; the panel passes `document.eol` straight through.
const EOL_CRLF = 2;

/** `Ln X, Col Y` — VS Code's built-in label. The caret is 0-based (VS Code
 *  `Position` convention); the status bar shows it 1-based. */
export function formatCaretPosition(caret: Caret): string {
  return `Ln ${caret.line + 1}, Col ${caret.character + 1}`;
}

/** `LF` / `CRLF` from a `vscode.EndOfLine` value (1 = LF, 2 = CRLF). Anything
 *  other than CRLF is reported as LF (matches the two-valued enum). */
export function formatEol(eol: number): string {
  return eol === EOL_CRLF ? "CRLF" : "LF";
}

/** A friendly language label from a `document.languageId`. Quoll only opens
 *  Markdown, so this is a lightweight capitalisation of the id (`markdown` →
 *  `Markdown`), NOT the full VS Code language-mode registry name. */
export function formatLanguageLabel(languageId: string): string {
  if (languageId.length === 0) {
    return languageId;
  }
  return languageId.charAt(0).toUpperCase() + languageId.slice(1);
}

/** Minimal surface of a `vscode.StatusBarItem` the controller drives. Injected
 *  as an interface so the show/hide/update/dispose logic is unit-testable
 *  without a live host. */
export interface StatusBarSlot {
  text: string;
  show(): void;
  hide(): void;
  dispose(): void;
}

/** The three slots the controller owns, in native left-to-right order (caret
 *  is leftmost / highest priority, language rightmost). */
export interface StatusBarSlots {
  caret: StatusBarSlot;
  eol: StatusBarSlot;
  language: StatusBarSlot;
}

/** Live inputs for a refresh: the 0-based caret and the document's EOL. */
export interface StatusBarView {
  caret: Caret;
  eol: number;
}

export interface StatusBarController {
  /** Refresh the caret + EOL text from the live document. */
  update(view: StatusBarView): void;
  /** Show all slots (call on the panel's active edge). */
  show(): void;
  /** Hide all slots (call on the inactive edge). */
  hide(): void;
  /** Dispose all slots (call when the panel is disposed). */
  dispose(): void;
}

/** Wire the injected slots into a controller. The language slot is static
 *  (set once); caret + EOL are seeded from `init` so a `show()` before the
 *  first `update()` never reveals a blank item. */
export function createStatusBarController(
  slots: StatusBarSlots,
  init: { view: StatusBarView; languageLabel: string }
): StatusBarController {
  slots.language.text = init.languageLabel;
  const all: readonly StatusBarSlot[] = [slots.caret, slots.eol, slots.language];

  const controller: StatusBarController = {
    update({ caret, eol }) {
      slots.caret.text = formatCaretPosition(caret);
      slots.eol.text = formatEol(eol);
    },
    show() {
      for (const slot of all) {
        slot.show();
      }
    },
    hide() {
      for (const slot of all) {
        slot.hide();
      }
    },
    dispose() {
      for (const slot of all) {
        slot.dispose();
      }
    },
  };

  controller.update(init.view);
  return controller;
}
