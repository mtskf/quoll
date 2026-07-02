// Explicit, user-triggered "apply lint fix" command.
//
// Autofix is OPT-IN and NEVER automatic: the lint layer only ever computes and
// underlines findings (display-only). The single byte-mutating path is this
// command, invoked by the user via the Mod-. keymap below.
//
// This command is a MUTATION boundary, so it does NOT trust the displayed
// diagnostic cache (lintField). That cache only maps positions through edits
// between debounced recomputes; it never re-evaluates rule conditions, so a
// fix held there can be stale (e.g. a one-space underline still showing after
// the user typed a second space, which is now a hard break that must NOT be
// "fixed"). Instead we re-lint the current document synchronously — affordable
// because this is an explicit keypress, not the keystroke critical path — and
// apply only what the CURRENT bytes warrant. The resulting change rides the
// parent dispatch -> edit-sync -> host write-lock pipeline like every other
// webview edit (it never postMessages the host directly). If the host
// write-gate rejected it (it won't, for pure whitespace deletion), the standard
// edit-rejected flow applies; no lint-specific handling is needed here.

import { type EditorState, type Extension, Prec } from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";

import { lintMarkdown } from "./engine.js";

/** The "apply fix" chord. Single source of truth — used by the keymap and
 *  pinned by a unit test. Mod = Cmd (mac) / Ctrl (win+linux). Chosen to mirror
 *  VS Code's own Quick Fix key: the native binding is `when: editorTextFocus`,
 *  which is false inside a custom-editor webview (same basis as the
 *  context-handoff Cmd+Alt+K chord), so VS Code's Quick Fix won't fire here and
 *  this binding handles it. A user/extension global Mod-. rebinding or an OS/
 *  browser accelerator is out of scope (as for any webview keybinding). Unlike
 *  context-handoff — which always claims its chord — this command returns false
 *  when nothing is fixable, so Mod-. is a no-op (passes through) on a clean line. */
export const LINT_FIX_KEY = "Mod-.";

type Fix = { from: number; to: number; insert: string };

/** Re-lint the current doc and collect the fixes whose range overlaps the line
 *  span of any selection range, as a sorted, non-overlapping change set.
 *  Iterating findings (not spans) yields each fix at most once, so a
 *  multi-cursor selection on one line never duplicates a change; the sort +
 *  first-wins overlap skip keep the change set valid for `dispatch` even if a
 *  future rule emits unordered or overlapping fixes. Pure (calls the engine);
 *  may throw if the engine throws — the caller catches. */
function collectFreshFixesForSelection(state: EditorState): Fix[] {
  const diagnostics = lintMarkdown(state.doc.toString());
  const spans = state.selection.ranges.map((r) => {
    // Exclude a line the selection only touches at its very start: a non-empty
    // range ending exactly at lineN.from selected lineN-1, not lineN (CM ranges
    // are half-open). A caret (empty) keeps its own line.
    const endPos = r.empty ? r.to : r.to - 1;
    return {
      from: state.doc.lineAt(r.from).from,
      to: state.doc.lineAt(endPos).to,
    };
  });
  const inScope: Fix[] = [];
  for (const d of diagnostics) {
    if (!d.fix) {
      continue;
    }
    const { from, to, insert } = d.fix;
    if (spans.some((s) => from <= s.to && to >= s.from)) {
      inScope.push({ from, to, insert });
    }
  }
  inScope.sort((a, b) => a.from - b.from || a.to - b.to);
  const docLength = state.doc.length;
  const fixes: Fix[] = [];
  let lastTo = -1;
  for (const f of inScope) {
    if (f.from < 0 || f.to > docLength || f.from > f.to) {
      continue; // malformed fix — defensive; no first-party rule emits these
    }
    if (f.from === f.to && f.insert === "") {
      continue; // collapsed delete -> no-op, skip
    }
    if (f.from < lastTo) {
      continue; // overlaps an already-accepted fix -> first-wins skip
    }
    fixes.push(f);
    lastTo = f.to;
  }
  return fixes;
}

/** Apply every in-scope lint fix as a single doc change. Guards read-only state
 *  (a raw changes-dispatch is NOT blocked by the readOnly facet) and fails open
 *  on any throw, mirroring safeLintMarkdown — lint is advisory, so a fix must
 *  never break the editor. Returns true when ≥1 fix applied (so the keymap
 *  claims the chord), false otherwise (so Mod-. passes through). */
export const applyLintFixAtSelection: Command = (view) => {
  if (view.state.readOnly) {
    return false;
  }
  try {
    const fixes = collectFreshFixesForSelection(view.state);
    if (fixes.length === 0) {
      return false;
    }
    view.dispatch({ changes: fixes, userEvent: "quoll.lint.fix" });
    return true;
  } catch (err) {
    console.error("[quoll] applyLintFixAtSelection failed", err);
    return false;
  }
};

/** Prec.high keymap binding LINT_FIX_KEY to the apply-fix command. Prec.high so
 *  it runs before defaultKeymap (which has no Mod-. binding today; high
 *  precedence future-proofs against one being added upstream). */
export function quollLintFixKeymap(): Extension {
  return Prec.high(keymap.of([{ key: LINT_FIX_KEY, run: applyLintFixAtSelection }]));
}
