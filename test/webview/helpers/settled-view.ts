import { forceParsing, syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { assertHasLanguage } from "./parse-to-end.js";

/**
 * The view-carrying twin of `settledState()`: force a MOUNTED view's parse to the end
 * of the document and republish the language field's tree snapshot, so anything reading
 * `syntaxTree(view.state)` — every `StateField` / `ViewPlugin` built from it — observes
 * a COMPLETE tree.
 *
 * Why a mounted view needs this at all. CodeMirror converges on its own in a real
 * browser: its background parse `ViewPlugin` gets idle time and dispatches its own
 * transaction when the parse finishes. happy-dom never runs that worker, so under
 * vitest a mounted view's fields stay built on the init-viewport fragment forever.
 * "It is a live view, so parsing runs" is FALSE here — a comment in
 * cm-fenced-code-language-picker.test.ts asserted exactly that and was wrong.
 *
 * Why the checks live INSIDE this helper rather than at the call sites. `forceParsing`
 * reports failure by RETURNING FALSE, and this suite discarded that boolean at 27 of
 * its 32 call sites (measured 2026-08-30). Six of those were near-identical four-line
 * `forceParse` wrappers, five of which dropped the result; three other files each
 * hand-rolled their own `expect(...).toBe(true)`. That is one problem with six
 * solutions, and the check fell out of most of them — so it is put where it cannot be
 * omitted rather than left as something each author must remember. A silently
 * non-converged settle otherwise surfaces as a baffling content mismatch far from its
 * cause, or passes vacuously because both sides of a comparison are equally truncated.
 *
 * The three failures are reported separately because they send the reader to different
 * places:
 *
 *   - no language attached — an extension-list fix, NOT a load problem. `forceParsing`
 *     alone returns an indistinguishable `false` in 0ms, the same conflation
 *     ./parse-to-end.ts exists to prevent; we borrow its probe so the wording cannot
 *     drift from the state-side helpers'.
 *   - budget exhausted — the parse CONTEXT never reached the document end.
 *   - snapshot still short — the context finished, but the published SNAPSHOT, which is
 *     what `syntaxTree(view.state)` actually returns, does not span the document. The
 *     gap between those two is the whole subject of ./settled-state.ts.
 *
 * The last one is DEFENSIVE: `forceParsing` dispatches an empty transaction whenever
 * the tree advanced, so a converged parse republishes and no conformant parser reaches
 * it. It is kept, and driven by a deliberately non-conformant stub in
 * ./settled-view.test.ts, for the same reason ./full-tree.ts keeps its own — a silent
 * partial is the one outcome this helper must never produce.
 *
 * Returns the SAME view, so it can wrap a constructor at a fixture factory:
 * `return settledView(new EditorView({ state, parent }))`.
 *
 * The default budget is 5_000ms, matching what the retired wrappers used, so migrating
 * a call site is a behaviour-preserving rename. Sites that passed 10_000 keep passing it.
 *
 * Lengths are UTF-16 code units (what `state.doc.length` counts), not bytes.
 * All three throws are pinned by ./settled-view.test.ts.
 */
export function settledView(view: EditorView, budgetMs = 5_000): EditorView {
  assertHasLanguage(view.state, "settledView");
  if (!forceParsing(view, view.state.doc.length, budgetMs)) {
    throw new Error(
      `settledView: parse did not complete within ${budgetMs}ms for a ${view.state.doc.length}-code-unit document`
    );
  }
  const covered = syntaxTree(view.state).length;
  if (covered < view.state.doc.length) {
    throw new Error(
      `settledView: snapshot still truncated (${covered} of ${view.state.doc.length} code units) after settling`
    );
  }
  return view;
}
