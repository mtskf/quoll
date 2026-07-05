// Cmd+Option+K (Mod-Alt-k) → hand the current selection to Claude Code.
//
// The chord lives HERE, in a CodeMirror keymap, not in package.json
// contributes.keybindings — so it fires only while the Quoll CM editor has
// focus inside the webview. Claude Code's own cmd+alt+K binding is scoped
// `when: editorTextFocus`, which is FALSE in a custom-editor webview, so the
// two never collide: VS Code's keybinding layer ignores the chord while the
// webview holds it, and CodeMirror handles it.
//
// The selection→line mapping is 1:1: Quoll is text-canonical, so the CM doc
// IS the file's raw Markdown and a CM line number equals the file line
// number. The webview sends only geometry; the host owns the path.
//
// Both handoff commands flush the pending debounced Edit BEFORE posting (see
// flushBeforeHandoff), mirroring the editor-switch barrier — otherwise a handoff
// fired inside edit-sync's 300 ms debounce window would reference host content
// that lacks the user's latest keystrokes.

import { type EditorState, type Extension, Prec } from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";

import { PROTOCOL_VERSION, type WebviewToHost } from "../../shared/protocol.js";

export type HandoffHost = { postMessage(message: WebviewToHost): void };

/** Flush any pending debounced Edit BEFORE posting a handoff. edit-sync
 *  debounces outbound Edits by 300 ms, so a handoff fired mid-window would hand
 *  Claude / Codex host/TextDocument content that lacks the user's latest
 *  keystrokes (the host only auto-saves when already dirty — webview-only edits
 *  are not covered). Flushing first makes the just-typed bytes reach the host
 *  BEFORE the handoff (FIFO). Same barrier as the editor-switch path
 *  (postSwitchToText). Logs, never throws — a throw would unwind CodeMirror's
 *  key dispatch. */
function flushBeforeHandoff(flushPendingEdit: () => void): void {
  try {
    flushPendingEdit();
  } catch (err) {
    console.error("[quoll] flushPendingEdit before handoff failed", err);
  }
}

/** The chord string. Single source of truth — used by the keymap and pinned
 *  by a unit test. Mod = Cmd (mac) / Ctrl (win+linux); Alt = Option (mac). */
export const CONTEXT_HANDOFF_KEY = "Mod-Alt-k";

/** The Codex chord string. Single source of truth — used by the keymap and
 *  pinned by a unit test. Mod = Cmd (mac) / Ctrl (win+linux). NOTE: VS Code's
 *  default Cmd+J = workbench.action.togglePanel is global (no `when` guard),
 *  unlike Claude's editorTextFocus-scoped Cmd+Option+K. A focused webview iframe
 *  captures keydown and this Prec.high keymap preventDefaults the chord (run
 *  returns true), so the panel toggle should not fire — verified in the manual
 *  smoke. Fallback ladder if it collides: add `stopPropagation: true` to the
 *  binding below, else change this to "Mod-Alt-j". */
export const CODEX_CONTEXT_HANDOFF_KEY = "Mod-j";

/** Map the MAIN selection range to 1-based inclusive line numbers. Pure doc
 *  math (lineAt) — no layout, so it is happy-dom safe. Multi-range selections
 *  use the main range only (matches Claude Code's native single-selection
 *  at-mention). An empty range (caret) reports hasSelection=false but still
 *  carries the caret line so the wire shape is uniform; the host emits a
 *  whole-file reference in that case. */
export function selectionToHandoff(state: EditorState): {
  hasSelection: boolean;
  startLine: number;
  endLine: number;
} {
  const { from, to, empty } = state.selection.main;
  const startLine = state.doc.lineAt(from).number;
  const endLine = state.doc.lineAt(to).number;
  return { hasSelection: !empty, startLine, endLine };
}

/** The handoff Command. Exported so the keymap test can invoke it directly on
 *  a real EditorView (black-box) rather than introspecting the Extension graph
 *  or firing a platform-dependent synthetic key event. */
export function contextHandoffCommand(host: HandoffHost, flushPendingEdit: () => void): Command {
  return (view) => {
    // Flush the pending debounced Edit FIRST so the handoff references the
    // just-typed content, not the pre-keystroke host snapshot (see
    // flushBeforeHandoff).
    flushBeforeHandoff(flushPendingEdit);
    const { hasSelection, startLine, endLine } = selectionToHandoff(view.state);
    const message: WebviewToHost = {
      protocol: PROTOCOL_VERSION,
      type: "context-handoff",
      hasSelection,
      startLine,
      endLine,
    };
    try {
      host.postMessage(message);
    } catch (err) {
      // Mirror the edit-post failure posture: log, never throw out of a
      // keymap command (a throw would unwind CodeMirror's key dispatch).
      console.error("[quoll] postMessage(context-handoff) failed", err);
    }
    // Return true unconditionally: the chord is "claimed" by Quoll whether or
    // not the post succeeded, so CodeMirror stops default handling and the
    // event never bubbles to a stale native binding.
    return true;
  };
}

/** The Codex handoff Command. Posts an envelope-only `codex-context-handoff`
 *  (Codex adds the WHOLE file via addFileToThread — no selection geometry).
 *  Exported so the keymap test can invoke it directly on a real EditorView. */
export function codexContextHandoffCommand(
  host: HandoffHost,
  flushPendingEdit: () => void
): Command {
  return () => {
    // Flush FIRST: Codex hands off the WHOLE file, so a stale host save would
    // ship pre-keystroke bytes (see flushBeforeHandoff).
    flushBeforeHandoff(flushPendingEdit);
    const message: WebviewToHost = {
      protocol: PROTOCOL_VERSION,
      type: "codex-context-handoff",
    };
    try {
      host.postMessage(message);
    } catch (err) {
      // Mirror contextHandoffCommand: log, never throw out of a keymap command.
      console.error("[quoll] postMessage(codex-context-handoff) failed", err);
    }
    // Claim the chord regardless so CodeMirror preventDefaults and the event
    // does not bubble to the workbench (togglePanel) — see CODEX_CONTEXT_HANDOFF_KEY.
    return true;
  };
}

/** Prec.high keymap binding both handoff chords: CONTEXT_HANDOFF_KEY → Claude
 *  Code, CODEX_CONTEXT_HANDOFF_KEY → Codex. Prec.high so they run before
 *  defaultKeymap and (for Mod-j) claim the chord before it could reach the
 *  workbench togglePanel binding. */
export function quollContextHandoffKeymap(
  host: HandoffHost,
  flushPendingEdit: () => void
): Extension {
  return Prec.high(
    keymap.of([
      { key: CONTEXT_HANDOFF_KEY, run: contextHandoffCommand(host, flushPendingEdit) },
      { key: CODEX_CONTEXT_HANDOFF_KEY, run: codexContextHandoffCommand(host, flushPendingEdit) },
    ])
  );
}
