import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { parseToEnd } from "./parse-to-end.js";

/**
 * The view-free twin of `forceParsing`: return an `EditorState` whose LANGUAGE
 * FIELD SNAPSHOT spans the whole document, so anything that reads
 * `syntaxTree(state)` — `foldable()` and every `foldService` / `foldNodeProp`
 * behind it — observes a COMPLETE tree.
 *
 * Why `fullTree` / `ensureSyntaxTree` alone is not enough (the snapshot split):
 * `syntaxTree(state)` returns `Language.state`'s `LanguageState.tree`, a
 * SNAPSHOT taken when that field value was constructed, whereas
 * `ensureSyntaxTree` advances the mutable parse CONTEXT and returns
 * `context.tree`. `LanguageState.init` builds the snapshot under a hardcoded
 * 20ms `Work.Apply` budget capped at a 3000-char init viewport, so on a state
 * freshly created from a large doc — or on a small one under CPU preemption —
 * the snapshot is TRUNCATED even after `ensureSyntaxTree` completes. A fold
 * query then resolves against the truncated tree and returns `null`: the
 * load-sensitive fold flake of docs/LEARNING.md (2026-07-23). That entry's
 * `settleParse` fix took an `EditorView`, so the state-only fold harnesses were
 * never covered — this helper closes that gap.
 *
 * `forceParsing` re-dispatches an empty transaction so the field rebuilds over
 * the finished tree; with no view to dispatch through, `state.update({}).state`
 * is the same move — `LanguageState.apply` sees `tree != context.tree` and
 * rebuilds. It is a cheap no-op when the snapshot already spans the doc (the
 * common, unloaded case), so the ordinary code path stays exercised.
 *
 * We THROW rather than return a partial state: a "settled" state that quietly
 * carried a truncated snapshot would resurrect the exact flake this helper
 * exists to kill.
 *
 * The return type is a plain `EditorState` and does NOT distinguish settled from
 * unsettled. A brand type would label what this function produces, but it could
 * not gate a single consumer: the consumer is CodeMirror's
 * `foldable(state: EditorState, …)`, so there is no seam at which a branded type
 * could be REQUIRED — the only callers that could get it wrong build their state
 * inline and never pass through such a parameter. The runtime throws are the
 * enforcement; the type is not.
 *
 * The truncated-snapshot throw below, and the no-language throw `parseToEnd`
 * raises for this helper, are pinned by ./settled-state.test.ts.
 */
export function settledState(state: EditorState): EditorState {
  parseToEnd(state, "settledState");
  const settled = state.update({}).state;
  const covered = syntaxTree(settled).length;
  if (covered < settled.doc.length) {
    throw new Error(
      `settledState: snapshot still truncated (${covered} of ${settled.doc.length} code units) after settling`
    );
  }
  return settled;
}
