import { ensureSyntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/**
 * Force a COMPLETE parse, then return the syntax tree.
 *
 * `syntaxTree(state)` on a freshly-created `EditorState` returns whatever the
 * parser produced within its bounded initial budget — a time slice that only
 * covers the document's leading region (CodeMirror parses roughly the first
 * viewport, a few KB, before yielding). Under CPU contention (e.g.
 * `parallel-checks` running lint + test concurrently) later nodes can be
 * missing, so a provider test that walks the tree flakes (one `Task` node
 * instead of two, a missing heading, etc.) only under load, staying green when
 * run alone.
 *
 * `ensureSyntaxTree(state, upto, timeout)` advances the parse to the end of the
 * document within 5s. For the sub-KB fixtures these provider tests use that is
 * effectively unbounded, so it always returns a complete tree. If it ever
 * returns `null` (the 5s budget was exhausted — only reachable on a very large
 * fixture under heavy load) we THROW rather than silently fall back to a
 * partial tree: a "fullTree" that quietly returned an incomplete tree would
 * resurrect the exact flake this helper exists to kill. Tests that DELIBERATELY
 * tolerate a partial tree (e.g. the viewport ratio assertion over a 1MB doc)
 * keep their own `?? syntaxTree(state)` fallback and must NOT use this helper.
 */
export function fullTree(state: EditorState) {
  const tree = ensureSyntaxTree(state, state.doc.length, 5_000);
  if (tree === null) {
    throw new Error(
      `fullTree: parse did not complete within 5s for a ${state.doc.length}-byte document`
    );
  }
  return tree;
}
