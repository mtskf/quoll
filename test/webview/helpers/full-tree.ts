import type { EditorState } from "@codemirror/state";
import { parseToEnd } from "./parse-to-end.js";

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
 * `parseToEnd` (./parse-to-end.ts) advances the parse to the end of the
 * document under a bounded time budget. For the sub-KB fixtures these provider
 * tests use that is effectively unbounded, so it always returns a complete tree.
 * If the parse does not finish we THROW rather than silently fall back to a
 * partial tree: a "fullTree" that quietly returned an incomplete tree would
 * resurrect the exact flake this helper exists to kill. Tests that DELIBERATELY
 * tolerate a partial tree (e.g. the viewport ratio assertion over a 1MB doc)
 * keep their own `?? syntaxTree(state)` fallback and must NOT use this helper.
 *
 * The throw lives in `parseToEnd` so that this helper and `settledState()` —
 * documented below as a matched pair — report the same two `null` causes the
 * same way; see that module for why a bare `ensureSyntaxTree(...) === null` is
 * not evidence of a timeout.
 *
 * ⚠️ This returns the tree `ensureSyntaxTree` produced; it does NOT repair the
 * state's own tree SNAPSHOT — `syntaxTree(state)` can still be truncated after
 * this call. If the assertion reads the tree THROUGH the state (`syntaxTree`,
 * `foldable()`, any `foldService` / `foldNodeProp`) rather than through the
 * returned tree, use `settledState()` in ./settled-state.ts instead.
 */
export function fullTree(state: EditorState) {
  const tree = parseToEnd(state, "fullTree");
  // `ensureSyntaxTree` decides success from the parse CONTEXT's `treeLen`
  // (`stoppedAt ?? doc.length`), not from the tree it hands back, so a non-null
  // return is not by itself evidence that the tree reaches the doc end.
  //
  // ⚠️ DEFENSIVE, not a live failure mode: no conformant Lezer parser reaches
  // this throw. ./settled-state.test.ts drives it with a deliberately
  // non-conformant stub, which pins that it fires and reports the coverage
  // numbers — not that anything in the tree today can produce a short tree.
  if (tree.length < state.doc.length) {
    throw new Error(
      `fullTree: parse reported success but the tree spans ${tree.length} of ${state.doc.length} code units`
    );
  }
  return tree;
}
