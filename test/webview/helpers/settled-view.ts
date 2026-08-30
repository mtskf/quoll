import { forceParsing, syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { assertHasLanguage, timeoutMessage, truncatedSnapshotMessage } from "./parse-to-end.js";

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
 * cm-fenced-code-language-picker.test.ts states exactly that and is wrong. That comment
 * is still in the tree: correcting it is out of this change's scope and belongs to the
 * follow-up that migrates the remaining hand-rolled settles.
 *
 * Why the checks live INSIDE this helper rather than at the call sites. `forceParsing`
 * reports failure by RETURNING FALSE, and most of this suite's call sites discarded
 * that boolean. Several files had each grown their own near-identical four-line
 * `forceParse` wrapper, and nearly all of those dropped the result; a few other files
 * hand-rolled an `expect(...).toBe(true)` of their own. That is one problem with as many
 * solutions as there are files, and the check fell out of most of them — so it is put
 * where an author using this helper cannot omit it, rather than left as something each
 * one must remember. (The census behind "most" belongs to the PR description, which is
 * dated and does not drift; repeating counts here would only rot.) A silently
 * non-converged settle otherwise surfaces as a baffling content mismatch far from its
 * cause, or passes vacuously because both sides of a comparison are equally truncated.
 *
 * ⚠️ "Cannot omit" reaches exactly that far. Nothing stops a new test from importing
 * `forceParsing` directly and discarding the boolean again — which is how the drift
 * accumulated in the first place. A choke-point guard would close that (this repo
 * mechanises the same shape in `test/build/no-file-level-ts-nocheck.test.ts` and
 * `url-choke-point.test.ts`) and would land green today, since the call below is the
 * only one left in `test/**`. Whether it earns its allowlist is recorded in
 * docs/TODO.md; until then this helper is a convention, not an enforcement.
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
 * The latter two messages are built by shared builders in ./parse-to-end.ts rather than
 * written out here, so the view-side and state-side wordings cannot drift: each copy
 * would be pinned only by its own helper's test.
 *
 * Returns the SAME view, so it can wrap a constructor at a fixture factory:
 * `return settledView(new EditorView({ state, parent }))`. On ANY of the three throws
 * the view is destroyed first, because in exactly that shape the caller never receives
 * the reference and could not destroy it itself — and an undisposed view keeps real
 * timers and a happy-dom document alive for the rest of the file. Call sites that pass
 * an already-bound view and destroy it in their own `finally` therefore destroy twice;
 * that is safe (`EditorView.destroy()` clears `plugins` and its sub-objects tolerate a
 * second call — measured under happy-dom, and pinned by ./settled-view.test.ts), and it
 * cannot be guarded from typed code anyway since `destroyed` is `private` in the `.d.ts`.
 *
 * ⚠️ ONE part of the teardown genuinely re-runs: `docView.destroy()` reaches each
 * widget's `destroy()` again, so a widget mounted on the view sees TWO destroy calls
 * (measured: 1 after the helper, 2 after the caller's `finally`). Every widget this
 * repo mounts has an idempotent `destroy()`, so nothing is wrong today — but a widget
 * whose `destroy()` is NOT idempotent would misbehave here, and it would do so while a
 * test is already failing, which is the worst moment to add noise. If you add such a
 * widget, either make its teardown idempotent or move view ownership out of this helper
 * (the redesign is recorded in docs/TODO.md). The alternative — dropping the destroy —
 * is not free either: it reinstates the leak this arm exists to close.
 *
 * ⚠️ The `(X) => X` shape is shared with `settledState()`, but the discard semantics are
 * OPPOSITE. Writing `settledView(view);` as a bare statement is correct — a view is
 * mutable, so the caller's view is settled either way — whereas the same discard on
 * `settledState(state);` is a SILENT NO-OP. Do not carry the statement form across to
 * the state-side sibling; see the warning in ./settled-state.ts.
 *
 * The default budget is 5_000ms, matching what the retired wrappers used, so migrating
 * a call site changes no timing. It is NOT a pure rename, though: the sites that
 * discarded `forceParsing`'s boolean move from a best-effort settle to one that THROWS
 * when the parse does not converge, which is a contract change and the point of the
 * exercise. Sites that passed 10_000 keep passing it.
 *
 * Lengths are UTF-16 code units (what `state.doc.length` counts), not bytes.
 * All three throws are pinned by ./settled-view.test.ts.
 */
export function settledView(view: EditorView, budgetMs = 5_000): EditorView {
  try {
    assertHasLanguage(view.state, "settledView");
    if (!forceParsing(view, view.state.doc.length, budgetMs)) {
      throw new Error(timeoutMessage("settledView", budgetMs, view.state.doc.length));
    }
    const covered = syntaxTree(view.state).length;
    if (covered < view.state.doc.length) {
      throw new Error(truncatedSnapshotMessage("settledView", covered, view.state.doc.length));
    }
  } catch (error) {
    view.destroy();
    throw error;
  }
  return view;
}
