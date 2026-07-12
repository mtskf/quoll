// Tab / Shift-Tab list-item indent (nest) / outdent (promote).
//
// When the caret sits inside a bullet / ordered / task list item, Tab nests the
// item under its indent destination (its preceding sibling, resolved ACROSS
// adjacent lists) at the destination parent's CONTENT column, and Shift-Tab
// promotes it to its parent's level — Notion/Obsidian structural nesting. The
// depth is MARKER-driven (CommonMark): a child's marker must reach the parent's
// content column, so a bullet nests by 2 (`- `) and an ordered item by 3
// (`1. `). This is not a free indent unit — a fixed "2 spaces" would leave
// ordered lists un-nested (`1. A` + 2-space `2. B` parses as a SIBLING, not a
// child). Both commands are THIN SHELLS: `planIndentItem` / `planOutdentItem`
// (in list-transform.ts) own resolution (EOF-bounded), every no-op case, the
// marker-adopt / renumber transform, and the caret; the shell just dispatches
// the returned `ChangeSpec[]` through `view.dispatch` so the change rides the
// normal updateListener → edit-sync → host write-lock pipeline and round-trips
// byte-identically.
//
// Return-value contract (this boolean is the CM `Command` "handled?" convention):
//   - read-only doc → false (view mode → normal focus nav; nothing to indent);
//   - EVERYTHING ELSE → true. In a list item we nest/promote (or a structural
//     no-op: first item has no indent destination; top-level item has no
//     parent). Outside a list, or inside FencedCode/CodeBlock, it is a no-op
//     that STILL returns true — swallowing Tab so it never escapes to VS Code
//     focus navigation (the user's original bug). a11y (intentional, matches
//     Notion/Obsidian): Tab is captured in the editable editor; keyboard focus
//     leaves via VS Code's F6 / Focus-Next-Part or the mouse, not Tab.

import { isolateHistory } from "@codemirror/commands";
import { Prec } from "@codemirror/state";
import { type Command, type EditorView, keymap } from "@codemirror/view";

import { type ListEditPlan, planIndentItem, planOutdentItem } from "./list-transform.js";

/** Dispatch the shift as ONE transaction; ALWAYS returns true (a `noop` plan =
 *  intentional no-op; a dead-view throw still means "we owned this Tab" — never
 *  fall through to CM's default Tab / escape focus). Annotates
 *  `isolateHistory.of("full")` so a single undo reverts the whole marker-adopt /
 *  renumber transform (matching `continueListOnEnter`), and forwards the
 *  optional `selection` the planner supplies for the empty-item caret. */
function applyShift(
  view: EditorView,
  plan: ListEditPlan,
  userEvent: "input.indent" | "delete.dedent"
): boolean {
  if (plan.kind === "noop") {
    return true;
  }
  try {
    view.dispatch({
      changes: plan.changes,
      ...(plan.selection === undefined ? {} : { selection: plan.selection }),
      userEvent,
      annotations: isolateHistory.of("full"),
    });
  } catch (err) {
    // Log enough context to diagnose a planner regression: `ChangeSet.of`
    // throws on OVERLAPPING ChangeSpecs (a disjointness-map bug) and
    // `view.dispatch` throws on an out-of-range selection — a bare `err` alone
    // does not say which transaction produced it.
    console.error("[quoll] list indent dispatch failed", {
      err,
      userEvent,
      docLength: view.state.doc.length,
      selection: view.state.selection.main,
      changeCount: plan.changes.length,
    });
  }
  return true;
}

/** Tab: nest the item at the caret under its indent destination at the parent's
 *  content column, ADOPTING the destination child-run's marker (or starting a
 *  new nested run + renumbering the vacated outer run). `planIndentItem` owns
 *  resolution (EOF-bounded) and every no-op case (caret in code, non-list, first
 *  item, fail-closed parse), each a `{ kind: "noop" }` plan. */
export const indentListItem: Command = (view) => {
  const { state } = view;
  if (state.readOnly) {
    return false;
  }
  return applyShift(view, planIndentItem(state, state.selection.main.head), "input.indent");
};

/** Shift-Tab: promote the item at the caret to its parent's level, ADOPTING the
 *  destination run's marker (bullet glyph ↔ ordered next-number), renumbering
 *  the run, re-homing forced children, and — for an EMPTY item — adopting the
 *  parent's task-ness. `planOutdentItem` owns resolution (EOF-bounded) and every
 *  no-op case (caret in code, non-list, top-level, fail-closed parse), each
 *  returning a `{ kind: "noop" }` plan. */
export const outdentListItem: Command = (view) => {
  const { state } = view;
  if (state.readOnly) {
    return false;
  }
  return applyShift(view, planOutdentItem(state, state.selection.main.head), "delete.dedent");
};

/** Keymap: Tab → indent, Shift-Tab → outdent. Prec.high so Tab is intercepted
 *  before CodeMirror's default (which would move focus out of the editor). */
export function listIndentKeymap() {
  return Prec.high(
    keymap.of([
      { key: "Tab", run: indentListItem },
      { key: "Shift-Tab", run: outdentListItem },
    ])
  );
}
