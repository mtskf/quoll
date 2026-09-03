import { ensureSyntaxTree, language } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/**
 * The callers that actually SETTLE a parse, and so the only ones that can reach either of
 * the two messages below. Written out as its own list rather than filtered out of
 * `ParseCaller` with an `Exclude<>`: a filter leaves a REMAINDER, so a caller added to the
 * union and forgotten on the exclusion list would silently be classified as settling. Here
 * the union below is the SUM of the two sides, and a new caller has to be written into one
 * of them.
 *
 * That keeps each builder's labels within the set of callers that can produce it: exactly
 * equal for `timeoutMessage`, and one wider than the truth for `truncatedSnapshotMessage`,
 * which `fullTree()` deliberately does not use (see its note below). That last gap is an
 * accepted looseness, not an oversight.
 */
type SettlingCaller = "fullTree" | "settledState" | "settledView" | "settledMount";

/**
 * The unstarved-frontier forms: they probe for a language and read the frontier, and never
 * advance a parse, so neither can honestly carry either parse-budget sentence. Exported so
 * ./unstarved-frontier.ts names THIS list rather than declaring a second copy of the same
 * literals — not because a copy would fail silently, which was the `Exclude<>` hazard the
 * sum above removed. Measured: a copy carrying an extra member reds at that module's
 * `Record<UnstarvedCaller, string>` and at its `assertHasLanguage` call, and a copy one
 * member short reds at the same `Record` and at the `caller` its own form passes. What the
 * export buys is that membership stays ONE fact rather than two that have to be kept equal;
 * every divergence above is repaired by re-syncing two lists instead of editing one.
 */
export type UnstarvedCaller = "withUnstarvedFrontier" | "withUnstarvedFrontierState";

/** Every caller `assertHasLanguage` accepts. Derived, so a new member must choose a side. */
type ParseCaller = SettlingCaller | UnstarvedCaller;

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
 * is a plausible mistake for a future caller; keeping the checks and their
 * wording in ONE module is what stops the messages drifting apart again.
 * `settledView()` settles a VIEW via `forceParsing` and so cannot route through
 * `parseToEnd` at all, which is why case (A) is exported separately as
 * `assertHasLanguage` and why the two message bodies are exported as builders
 * rather than written out at each throw site: every copy of a message is only
 * pinned by its own helper's test, so a copy can be reworded while the rest of
 * the suite stays green.
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
export function parseToEnd(state: EditorState, caller: SettlingCaller, budgetMs = 5_000) {
  assertHasLanguage(state, caller);
  const tree = ensureSyntaxTree(state, state.doc.length, budgetMs);
  if (tree === null) {
    throw new Error(timeoutMessage(caller, budgetMs, state.doc.length));
  }
  return tree;
}

/**
 * Case (A) above, on its own, so the view-side helpers can reuse it. They settle through
 * `forceParsing`, which needs the VIEW rather than the state, so they cannot call
 * `parseToEnd` at all — but they inherit the same conflation: `forceParsing` is
 * `ensureSyntaxTree` plus a conditional dispatch and collapses to the same falsy result
 * for both causes. Exporting the probe rather than copying it is what keeps every helper
 * that settles a parse reporting a missing language in identical words.
 *
 * Which helper calls this, and through what, is ./settled-view.ts's business — naming a
 * call chain here only dates the comment the next time that file rearranges one.
 */
export function assertHasLanguage(state: EditorState, caller: ParseCaller): void {
  if (state.facet(language) === null) {
    throw new Error(
      `${caller}: state has no language configured — no Language extension is attached, so there is nothing to parse`
    );
  }
}

/**
 * The budget-exhausted message, shared by `parseToEnd` above and by the view-side
 * settle, which reaches the same condition through `forceParsing`'s `false`.
 */
export function timeoutMessage(
  caller: SettlingCaller,
  budgetMs: number,
  docLength: number
): string {
  return `${caller}: parse did not complete within ${budgetMs}ms for a ${docLength}-code-unit document`;
}

/**
 * The short-snapshot message, shared by the state-side and view-side settles. Neither
 * routes through `parseToEnd` for this check — the published SNAPSHOT is read after the
 * parse step, from the state and from the view's state respectively — so the builder,
 * not a common call site, is what keeps them worded alike.
 *
 * `fullTree()` deliberately does NOT use it: it reports the tree `ensureSyntaxTree`
 * returned rather than a republished snapshot, which is a different fact and reads as a
 * different sentence.
 */
export function truncatedSnapshotMessage(
  caller: SettlingCaller,
  covered: number,
  docLength: number
): string {
  return `${caller}: snapshot still truncated (${covered} of ${docLength} code units) after settling`;
}
