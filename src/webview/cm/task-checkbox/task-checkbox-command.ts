// Task-list checkbox toggle command. Single home for both the marker
// validation regex and the dispatch path. Lives in its own file so
// neither widget nor reveal imports the other (Codex round-2 #12).
//
// Guards layered in order of cheapness:
//   1. readOnly state — EditorState.readOnly blocks native input but
//      NOT programmatic dispatch; we MUST check explicitly or a
//      read-only doc would still mutate on widget click (Codex round-2
//      #16).
//   2. bounds + regex on the 3-byte slice — cheapest stale-from guard
//      (Codex round-1 #7 / EH round-1 #1).
//   3. Lezer syntaxTree cross-check — resolve the node at markerFrom
//      and assert it is a TaskMarker that starts EXACTLY at markerFrom,
//      OR a content-less bare-marker `Paragraph` (`- [ ]`, which the GFM
//      parser leaves as a `Paragraph` with no Task/TaskMarker; accepted
//      only when `isContentlessTaskParagraph` confirms it is the item's
//      first content). Catches the insert-above race where the captured
//      `from` now points at a DIFFERENT (still-valid) marker (EH round-2 #21).
//   4. try/catch on dispatch — destroyed-view race during webview
//      tear-down (Codex round-1 #9 / EH round-1 #3).
//
// `isolateHistory.of("full")` forces each toggle into its own undo
// group (Codex round-1 #8 / EH round-1 #2).

import { isolateHistory } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, type Extension, Prec } from "@codemirror/state";
import { type Command, type EditorView, keymap } from "@codemirror/view";
import {
  resolveContentlessTaskMarkerGeometry,
  resolveTaskMarkerGeometry,
  type TaskMarkerGeometry,
} from "../list/list-geometry.js";
import { isContentlessTaskParagraph, TASK_MARKER_RE } from "./task-marker-shape.js";

// Single source of truth for the GFM TaskMarker shape — `[ ]`, `[x]`, or `[X]`.
// The regex + the content-less structural predicate now live in the zero-dep
// leaf `task-marker-shape.ts` so both the toggle (here) and the geometry / reveal
// side can share ONE definition without an import cycle (Codex finding #4).
// Re-exported so `findTaskMarker` (in reveal) and existing import sites are
// unaffected.
export { TASK_MARKER_RE };

/** Toggle the GFM task-list checkbox marker that starts at `markerFrom`.
 *  Returns `true` when a dispatch was issued, `false` when any guard
 *  aborted the toggle or the dispatch threw on a dead view.
 *
 *  The function is total in the sense that it NEVER throws — every
 *  abort path returns `false` and never partially mutates the doc. */
export function toggleTaskCheckbox(view: EditorView, markerFrom: number): boolean {
  // (1) readOnly — EditorState.readOnly blocks native input, NOT
  // programmatic dispatch (Codex round-2 #16). Without this, a click on
  // a widget in a read-only doc would still mutate the bytes.
  if (view.state.readOnly) {
    return false;
  }
  // (2) bounds + regex on the 3-byte slice — the cheapest stale-from
  // guard catches the "marker deleted entirely" case (Codex round-1
  // #7 / EH round-1 #1).
  if (markerFrom < 0 || markerFrom + 3 > view.state.doc.length) {
    return false;
  }
  const slice = view.state.doc.sliceString(markerFrom, markerFrom + 3);
  if (!TASK_MARKER_RE.test(slice)) {
    return false;
  }
  // (3) Lezer syntaxTree cross-check — structural guard that the bytes at
  // `markerFrom` belong to a real `TaskMarker` node that STARTS exactly there,
  // OR to a CONTENT-LESS bare-marker `Paragraph` (`- [ ]`, which the parser
  // leaves as a `Paragraph` with no `Task`/`TaskMarker`). The content-less
  // arm goes through `isContentlessTaskParagraph` — the SAME predicate the
  // reveal/geometry use — which requires the Paragraph to be the item's FIRST
  // content, so a later `[ ]` paragraph (`- first\n\n  [ ]`) is rejected.
  // Either way this catches the inline-code false positive (3 bytes literally
  // spelling `[ ]` inside an `InlineCode` span — regex would pass, structure
  // would not: its enclosing Paragraph does not start at `markerFrom` and its
  // parent is not a `ListItem`). Does NOT catch the
  // insert-above-with-exact-position-alignment race (a new TaskMarker landing
  // at exactly the OLD `markerFrom` byte offset — both checks pass, wrong task
  // toggles); that residual is bounded in practice by the provider's docChanged
  // rebuild and is documented in the plan's Risks §12. The tree may also be
  // mid-incremental-parse and stale; in that case the cross-check accepts the
  // click on the OLD marker position, which is the least-disruptive fallback
  // (dropping ALL clicks during async parses would be far worse).
  const tree = syntaxTree(view.state);
  let node = tree.resolveInner(markerFrom, 1);
  while (node.parent !== null && node.name !== "TaskMarker" && node.name !== "Paragraph") {
    node = node.parent;
  }
  const isTaskMarker = node.name === "TaskMarker" && node.from === markerFrom;
  const isContentless =
    node.name === "Paragraph" &&
    node.from === markerFrom &&
    isContentlessTaskParagraph(view.state, node);
  if (!isTaskMarker && !isContentless) {
    return false;
  }
  const middle = slice.charAt(1);
  const checked = middle === "x" || middle === "X";
  // GFM canonical lowercase `x` on toggle to checked; space on toggle
  // to unchecked. `[X]` normalises to `[ ]` → ` ` → `[x]` (Risks #2).
  const next = checked ? " " : "x";
  // (4) try/catch — destroyed-view race during webview tear-down
  // (Codex round-1 #9 / EH round-1 #3). The catch path is silent to
  // the user — Risks §11 documents the no-feedback gap.
  try {
    view.dispatch({
      changes: { from: markerFrom + 1, to: markerFrom + 2, insert: next },
      userEvent: "input.checkbox.toggle",
      annotations: isolateHistory.of("full"),
    });
    return true;
  } catch (err) {
    console.error("[quoll] checkbox toggle dispatch failed", err);
    return false;
  }
}

/** Resolve the doc position of the `[` opening bracket of the task-list marker
 *  whose marker line the caret at `pos` sits on, or null when the caret's line
 *  is not a task item's marker line.
 *
 *  Mirrors the reveal's build logic — `resolveTaskMarkerGeometry` for a
 *  content-bearing `Task`, `resolveContentlessTaskMarkerGeometry` for a bare
 *  `- [ ]` `ListItem` — so the keyboard toggle targets EXACTLY the tasks that
 *  render a checkbox (the same fail-closed contract). The on-line guard
 *  (`markerFrom` starts on the caret's own line) picks the INNERMOST task when
 *  the caret is on a nested item and ignores an ancestor task whose marker sits
 *  on an earlier line, so `Mod-l` toggles the item the caret is actually on.
 *
 *  Resolves the tree with `ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state)`
 *  — a bounded parse THROUGH the caret line before walking, matching every other
 *  caret-triggered tree command in the webview (fenced-code-enter-keymap,
 *  list-continuation-keymap, list-tree). `syntaxTree(state)` alone may be
 *  incomplete past the initial parse budget, which would make the toggle a
 *  silent no-op on a real task line whose region has not been parsed yet; the
 *  50 ms budget forces the caret line in and falls back to the partial tree if
 *  the parse cannot reach it. */
export function findTaskMarkerOnLine(state: EditorState, pos: number): number | null {
  const line = state.doc.lineAt(pos);
  let markerFrom: number | null = null;
  const tree = ensureSyntaxTree(state, line.to, 50) ?? syntaxTree(state);
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (markerFrom !== null) {
        return false; // first match wins — stop descending
      }
      let geom: TaskMarkerGeometry | null = null;
      if (node.name === "Task") {
        geom = resolveTaskMarkerGeometry(state, node.node);
      } else if (node.name === "ListItem") {
        // Content-BEARING items return null here (their `Task` child is handled
        // above), so a nested-task ancestor never false-matches on this branch.
        geom = resolveContentlessTaskMarkerGeometry(state, node.node);
      }
      if (geom !== null && state.doc.lineAt(geom.taskMarkerFrom).from === line.from) {
        markerFrom = geom.taskMarkerFrom;
        return false;
      }
      return undefined;
    },
  });
  return markerFrom;
}

/** Toggle the task-list checkbox on the caret's line. Returns `true` when a
 *  toggle was dispatched (so the keymap claims the chord), `false` when the
 *  caret is not on a task line OR a `toggleTaskCheckbox` guard aborted (read-only,
 *  dead view) — so the chord passes through as a no-op on ordinary lines, same
 *  posture as the lint-fix / code-ref caret commands.
 *
 *  Uses the MAIN selection head only: a multi-range selection toggles the
 *  primary caret's line, matching the single-target mouse/widget path (KISS —
 *  multi-caret checkbox toggling is not a stated requirement). This command is
 *  the keyboard path that the Tab-unreachable inline `Decoration.replace` widget
 *  cannot provide (see task-checkbox-widget.ts): with the caret on the task
 *  line the source `[ ]` renders as editable text (the widget is suppressed),
 *  and this toggles that source through the normal edit-sync pipeline. */
export const toggleTaskCheckboxAtCaret: Command = (view) => {
  const markerFrom = findTaskMarkerOnLine(view.state, view.state.selection.main.head);
  if (markerFrom === null) {
    return false;
  }
  return toggleTaskCheckbox(view, markerFrom);
};

/** The "toggle task checkbox" chord. Single source of truth — used by the keymap
 *  and pinned by a unit test. Mod = Cmd (mac) / Ctrl (win+linux). Matches
 *  Obsidian's "Toggle checkbox status" binding, is unbound in CodeMirror's
 *  `defaultKeymap`, and — like the `Mod-.` lint-fix chord — VS Code's own
 *  `editorTextFocus`-gated bindings do not fire inside a custom-editor webview,
 *  so this binding owns the chord here. The command returns false off a task
 *  line, so `Mod-l` is a pass-through no-op everywhere else. */
export const TASK_TOGGLE_KEY = "Mod-l";

/** Prec.high keymap binding TASK_TOGGLE_KEY to the caret toggle command.
 *  Prec.high so it is tried before `defaultKeymap` (which has no `Mod-l` binding
 *  today; high precedence future-proofs against one being added upstream). */
export function quollTaskCheckboxKeymap(): Extension {
  return Prec.high(keymap.of([{ key: TASK_TOGGLE_KEY, run: toggleTaskCheckboxAtCaret }]));
}
