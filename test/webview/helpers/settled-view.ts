import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorView, type EditorViewConfig } from "@codemirror/view";
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
 * "It is a live view, so parsing runs" is FALSE here — `cm-fenced-code-language-picker.test.ts`
 * used to say exactly that; it now settles through `settledMount` instead, which is why
 * every mounted fixture goes through this helper rather than relying on the mount alone.
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
 * ⚠️ LIFECYCLE: this function does NOT destroy the view, on any path. It briefly did, to
 * close the leak a factory hits when it settles a view before handing the reference back,
 * so a throw leaves the caller nothing to dispose. But owning the teardown of a view it
 * did not create made every caller that binds its own view and disposes it in a `finally`
 * destroy twice, and CM's `docView.destroy()` re-runs each widget's `destroy()` — which
 * this repo's widgets survived (the suite was green while the double `destroy()` was in
 * place) but a future non-idempotent one would not, and precisely while a test is already
 * failing. `settledMount()` below closes that leak from the other end, by owning what it
 * constructs; its docblock states the ownership rule. Here ownership stays with the
 * caller, which is where it started.
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
  return settleMountedView(view, budgetMs, "settledView");
}

/**
 * Construct a view and settle it, destroying it if the settle throws.
 *
 * This is what a fixture factory wants — `return settledMount({ state, parent })` — and
 * it closes the leak that `settledView()` alone cannot: whenever a factory constructs a
 * view and settles it BEFORE the reference reaches an owner, a throw strands a mounted
 * view with its timers and its happy-dom document alive for the rest of the file. The
 * leak lives in that un-owned window, not in one syntactic shape — the one-expression
 * `return settledView(new EditorView(…))` and the two-statement
 * `const v = new EditorView(…); settledView(v); return v;` are equally exposed — so no
 * claim is made here about how many shapes of it the suite ever contained.
 *
 * The line between the two helpers is OWNERSHIP, not shape: whoever constructs the view
 * owes its `destroy()`. `settledMount` constructs, so disposing on failure discharges its
 * OWN obligation; `settledView` is handed a view someone else built, so destroying it
 * would seize the caller's obligation and double-destroy at every site that already
 * disposes in a `finally`.
 *
 * On success the view comes back undestroyed and disposal is the caller's, exactly as if
 * they had written `new EditorView(...)` themselves.
 *
 * Both halves — destroy on throw, leave attached on success — are pinned by
 * ./settled-view.test.ts.
 *
 * The three settle failures are reported under `settledMount:`, not under the name of the
 * helper it delegates to: a message that names `settledView` sends the reader to a call
 * the test never wrote. That is the whole reason ./parse-to-end.ts takes a `caller`, so
 * the shared guards below are parameterised by it rather than reached through
 * `settledView`.
 */
export function settledMount(config: EditorViewConfig, budgetMs = 5_000): EditorView {
  const view = new EditorView(config);
  try {
    return settleMountedView(view, budgetMs, "settledMount");
  } catch (error) {
    view.destroy();
    throw error;
  }
}

/**
 * The three guards themselves, shared by both exported helpers above so neither owns a
 * second copy of them. It is deliberately NOT exported: the two entry points differ in
 * ownership (see `settledMount`'s docblock), and a third caller passing its own label
 * would be a helper with neither ownership rule documented.
 *
 * `caller` is threaded through instead of fixed here for the reason ./parse-to-end.ts's
 * docblock gives: the thrown message must name the helper the TEST called. The union is
 * narrowed to the two names this file exports, so `parseToEnd`'s state-side labels cannot
 * be smuggled in through here.
 *
 * Why each of the three failures is reported separately, and why the last one is kept
 * despite being unreachable for a conformant parser, is documented on `settledView` above.
 */
function settleMountedView(
  view: EditorView,
  budgetMs: number,
  caller: "settledView" | "settledMount"
): EditorView {
  assertHasLanguage(view.state, caller);
  if (!forceParsing(view, view.state.doc.length, budgetMs)) {
    throw new Error(timeoutMessage(caller, budgetMs, view.state.doc.length));
  }
  const covered = syntaxTree(view.state).length;
  if (covered < view.state.doc.length) {
    throw new Error(truncatedSnapshotMessage(caller, covered, view.state.doc.length));
  }
  return view;
}
