import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

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
 */
export function settledState(state: EditorState): EditorState {
  if (ensureSyntaxTree(state, state.doc.length, 5_000) === null) {
    throw new Error(
      `settledState: parse did not complete within 5s for a ${state.doc.length}-byte document`
    );
  }
  const settled = state.update({}).state;
  const covered = syntaxTree(settled).length;
  if (covered < settled.doc.length) {
    throw new Error(
      `settledState: snapshot still truncated (${covered} of ${settled.doc.length} bytes) after settling`
    );
  }
  return settled;
}
