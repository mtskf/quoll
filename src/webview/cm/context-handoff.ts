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
// Both handoff commands wait for edit-sync to settle BEFORE posting (see
// afterSettled) — a handoff posted inside the debounce window, or behind an
// in-flight Edit, would reference host content that lacks the user's latest
// keystrokes.

import { type EditorState, type Extension, Prec } from "@codemirror/state";
import { type Command, type EditorView, keymap } from "@codemirror/view";

import { PROTOCOL_VERSION, type WebviewToHost } from "../../shared/protocol.js";
import { type PostMessageHost, safePostMessage } from "../safe-post-message.js";

export type HandoffHost = PostMessageHost;

/** Run `post` once the host holds the text the user is looking at. edit-sync
 *  debounces outbound Edits and single-flights them, so a handoff posted
 *  straight away would point Claude / Codex at host content that lacks what the
 *  user just typed (the host only saves a document it knows is dirty). `settle`
 *  flushes and waits for the ack; `false` means the text will not get there
 *  (refused, superseded, timed out) or the editor is gone, and the
 *  handoff is NOT sent — stale context is worse than none. `settle` owns
 *  telling the user. Logs, never throws: a throw would unwind CodeMirror's key
 *  dispatch. */
async function afterSettled(
  view: EditorView,
  settle: () => Promise<boolean>,
  post: () => void
): Promise<void> {
  try {
    // Called synchronously, inside the key dispatch: the waiter exists before
    // anything else can run, so a teardown always finds it to cancel.
    const settled = await settle();
    // Same synchronous section as the post, after the LAST await. On today's
    // event path nothing can run between `settle` resolving and here (only
    // microtasks do), so this never fires; it keeps a post off a destroyed
    // editor if a caller ever schedules `settle` differently. `destroy()`
    // removes `view.dom`.
    if (settled && view.dom.isConnected) {
      post();
    }
  } catch (err) {
    console.error("[quoll] handoff not sent: waiting for edit-sync failed", err);
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
  // CM selection ranges are half-open [from, to): when a selection ends exactly
  // at a line start (e.g. it swallows the trailing newline), `to` sits on the
  // NEXT line, which has no selected character. Anchor the end line to the last
  // selected offset (to - 1) so the reported range covers only lines the user
  // actually touched. `from < to` holds for every non-empty range, so to - 1
  // never precedes `from`. Empty carets keep `to` (== from) so they stay on the
  // caret line.
  const endOffset = empty ? to : to - 1;
  const endLine = state.doc.lineAt(endOffset).number;
  return { hasSelection: !empty, startLine, endLine };
}

/** The handoff Command. Exported so the keymap test can invoke it directly on
 *  a real EditorView (black-box) rather than introspecting the Extension graph
 *  or firing a platform-dependent synthetic key event. */
export function contextHandoffCommand(host: HandoffHost, settle: () => Promise<boolean>): Command {
  return (view) => {
    void afterSettled(view, settle, () => {
      // Captured AFTER the wait: the user may have typed or moved the selection
      // while it ran, and line numbers taken before would point somewhere else.
      const { hasSelection, startLine, endLine } = selectionToHandoff(view.state);
      const message: WebviewToHost = {
        protocol: PROTOCOL_VERSION,
        type: "context-handoff",
        hasSelection,
        startLine,
        endLine,
      };
      // Log, never throw (see afterSettled) — safePostMessage handles that.
      safePostMessage(host, message, "context-handoff");
    });
    // Claimed whether or not anything is posted, so CodeMirror stops default
    // handling and the event never bubbles to a stale native binding.
    return true;
  };
}

/** The Codex handoff Command. Posts an envelope-only `codex-context-handoff`
 *  (Codex adds the WHOLE file via addFileToThread — no selection geometry).
 *  Exported so the keymap test can invoke it directly on a real EditorView. */
export function codexContextHandoffCommand(
  host: HandoffHost,
  settle: () => Promise<boolean>
): Command {
  return (view) => {
    // Codex hands off the WHOLE file, so host content behind the view would
    // ship pre-keystroke bytes (see afterSettled).
    void afterSettled(view, settle, () => {
      const message: WebviewToHost = { protocol: PROTOCOL_VERSION, type: "codex-context-handoff" };
      safePostMessage(host, message, "codex-context-handoff");
    });
    // Claim the chord regardless so the event does not bubble to the workbench
    // (togglePanel) — see CODEX_CONTEXT_HANDOFF_KEY.
    return true;
  };
}

/** Prec.high keymap binding both handoff chords: CONTEXT_HANDOFF_KEY → Claude
 *  Code, CODEX_CONTEXT_HANDOFF_KEY → Codex. Prec.high so they run before
 *  defaultKeymap and (for Mod-j) claim the chord before it could reach the
 *  workbench togglePanel binding. */
export function quollContextHandoffKeymap(
  host: HandoffHost,
  settle: () => Promise<boolean>
): Extension {
  return Prec.high(
    keymap.of([
      { key: CONTEXT_HANDOFF_KEY, run: contextHandoffCommand(host, settle) },
      { key: CODEX_CONTEXT_HANDOFF_KEY, run: codexContextHandoffCommand(host, settle) },
    ])
  );
}
