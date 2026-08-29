import { ensureSyntaxTree, language } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

type ParseCaller = "fullTree" | "settledState";

/**
 * Shared parse step behind `fullTree()` and `settledState()`: advance the state's
 * parse CONTEXT to the end of the document and return the resulting tree, or
 * throw an error that names the ACTUAL cause.
 *
 * Why both helpers route through here rather than each calling
 * `ensureSyntaxTree` themselves: `ensureSyntaxTree` collapses two unrelated
 * failures into a single `null`
 * (node_modules/@codemirror/language/dist/index.cjs — it reads
 * `state.field(Language.state, false)?.context` and returns `null` when that is
 * absent, before any parse work happens):
 *
 *   (A) the state has no language extension at all — returns in 0ms, entirely
 *       unrelated to elapsed time or CPU load;
 *   (B) the parse budget really was exhausted.
 *
 * A message that tells story (B) for case (A) sends the reader chasing CPU
 * contention for what is a one-line extension list fix, so we test for a
 * language FIRST and only then attribute a `null` to the timeout. Both helpers
 * are generically named and live in a shared `helpers/` directory, so case (A)
 * is a plausible mistake for a future caller; keeping the two throw sites in ONE
 * function is what stops the two messages drifting apart again.
 *
 * The probe is the public `language` FACET rather than the `Language.state`
 * field `ensureSyntaxTree` itself reads: that field is `@internal` (absent from
 * the `.d.ts`, so it cannot be referenced from type-checked code) and the facet
 * is what `enables` it, making the two conditions the same condition.
 *
 * `caller` is the helper name to prefix, so the thrown message still points at
 * the helper the test actually called. It is a closed union rather than `string`
 * so an unknown label — a typo, or a new helper's — is a compile error until it
 * is added here.
 *
 * `budgetMs` is a parameter rather than a literal so the timeout arm can be
 * driven without a five-second hang, and the message quotes the value it was
 * actually given rather than a second copy of the default.
 *
 * Lengths in the messages are UTF-16 code units (what `state.doc.length`
 * counts), not bytes.
 */
export function parseToEnd(state: EditorState, caller: ParseCaller, budgetMs = 5_000) {
  if (state.facet(language) === null) {
    throw new Error(
      `${caller}: state has no language configured — no Language extension is attached, so there is nothing to parse`
    );
  }
  const tree = ensureSyntaxTree(state, state.doc.length, budgetMs);
  if (tree === null) {
    throw new Error(
      `${caller}: parse did not complete within ${budgetMs}ms for a ${state.doc.length}-code-unit document`
    );
  }
  return tree;
}
