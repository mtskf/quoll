// Resolve a classified link destination against THIS document.
//
// cm/link-target.ts answers "what is this destination?" from the string alone
// and must stay that way (pure, total, no CM state). One arm cannot be answered
// that way: a `#slug` fragment acts only if the document actually has a heading
// with that slug. This module is that second stage, and it is deliberately the
// ONLY place the question is asked — cm/link-handlers.ts (click) and
// cm/decorations/link-reveal.ts (pointer cursor) both consume its output, so
// the affordance cannot over-promise the behaviour. (One-directional on
// purpose: the two pass different `ParseReach` values, so the pointer may
// under-promise — see `isActionableLinkTarget` and `resolveLinkTarget`.)
//
// TOTALITY IS A HARD CONTRACT — link-reveal calls this inside a
// DecorationProvider.build(), where a throw permanently deactivates the whole
// inline-reveal layer (see link-target.ts's header). Two non-string calls are
// reachable. `ensureSyntaxTree` is total — it reports an exhausted budget by
// returning null. `Text.lineAt` is NOT: it throws RangeError for a position
// outside the document, and `state` and `tree` arrive as INDEPENDENT arguments,
// so a stale tree over a SHORTENED document really can offer a heading span past
// `doc.length`. buildSlugIndex's in-document guard is what makes that span never
// reach `lineAt`. (Measured: such a span would also slug to "" and be skipped,
// because `Text.sliceString` clamps rather than throwing — but that is an
// accident of the empty-slug branch, not a contract. The guard is what this
// paragraph's claim actually rests on.) Everything else here is tree walk +
// string + Map work.
//
// NO-URL POLICY: `slug` is href-derived. Look it up, never log it.

import { ensureSyntaxTree, type syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";

import { collectHeadings, headingSlugSource, slugifyHeadingText } from "./headings.js";
import type { LinkTarget } from "./link-target.js";

type Tree = ReturnType<typeof syntaxTree>;

type SlugIndex = {
  /** The exact Text this index was built from — see the cache comment. */
  readonly doc: Text;
  /** slug → document offset of the heading's LINE start. */
  readonly bySlug: ReadonlyMap<string, number>;
};

/** Memoised per Lezer Tree. Rebuilding costs a full-tree heading walk, and
 *  link-reveal would otherwise pay it once per VISIBLE fragment link — a
 *  table-of-contents document turns an O(nodes) walk into O(links × nodes) on
 *  every viewport/selection rebuild. A WeakMap keyed by the tree lets the entry
 *  die with the tree.
 *
 *  What the memo does NOT buy: an edit produces a new Tree, so a document with a
 *  visible fragment link rebuilds the index once per keystroke. Accepted: the
 *  walk is O(nodes) with no per-link allocation, and it runs only while such a
 *  link is on screen — outline-panel.ts debounces the identical walk if this
 *  ever needs the same treatment.
 *
 *  The stored `doc` is the invalidation guard, and it is an IDENTITY check, not
 *  a length check: CodeMirror's Text is persistent, so any change produces a new
 *  object, while a pure selection change (the common decoration rebuild) keeps
 *  the same one and hits the cache. A length comparison would silently serve
 *  stale offsets across an equal-length edit — `# Alpha` → `# Gamma`. */
const SLUG_INDEX_CACHE = new WeakMap<Tree, SlugIndex>();

/** Build the slug → line-start map in document order.
 *
 *  Duplicate heading text follows github-slugger: the first occurrence takes the
 *  bare slug, and a later one steps through `-1`, `-2`, … until it finds a slug
 *  nobody has claimed. Stepping (rather than a per-base counter) is what keeps
 *  `# A`, `# A-1`, `# A` addressable — the third heading lands on `a-2` instead
 *  of colliding with the literal `# A-1` and becoming unreachable.
 *
 *  A heading whose text slugs to the empty string (a bare `#`, a symbols-only
 *  heading) contributes NO entry — it has no anchor to link to, and
 *  classifyLinkTarget never emits an empty slug. */
function buildSlugIndex(state: EditorState, tree: Tree): Map<string, number> {
  const bySlug = new Map<string, number>();
  for (const { from, to } of collectHeadings(tree)) {
    // TOTALITY GUARD (see the header): `tree` is an independent argument, so it
    // may be stale relative to a SHORTENED `state.doc`, and `doc.lineAt(from)`
    // below throws RangeError for a position past the end — inside a
    // DecorationProvider.build() that kills the whole inline-reveal layer.
    // Skip such a heading: the tree that describes it no longer describes this
    // document, so it has no anchor to offer. Deliberately BEFORE the slug work
    // rather than relying on it — an out-of-document span happens to slug to ""
    // today (sliceString clamps), which would make the safety a side effect of
    // the empty-slug branch and one reordering away from a live crash.
    if (to > state.doc.length) {
      continue;
    }
    // Node span, NOT line.text: a heading nested in a blockquote / list item
    // has its container marks ("> ", "- ") OUTSIDE [from, to).
    //
    // RENDERED content, not raw source: headingSlugSource drops the inline
    // markup nodes so `# A [link](b)` is addressable as `#a-link` — the anchor
    // GitHub produces, and the only one a reader of the (syntax-hidden) Quoll
    // rendering could guess.
    const base = slugifyHeadingText(headingSlugSource(state, tree, from, to));
    if (base === "") {
      continue;
    }
    let slug = base;
    for (let n = 1; bySlug.has(slug); n += 1) {
      slug = `${base}-${n}`;
    }
    // Line start, not node start — matches the outline panel's jump target, so
    // a nested heading scrolls with its container mark visible.
    bySlug.set(slug, state.doc.lineAt(from).from);
  }
  return bySlug;
}

/** Document offset to scroll to for `slug`, or null when no heading in `tree`
 *  matches. `slug` is expected in slugified form (classifyLinkTarget normalises
 *  the fragment through the same `slugifyHeadingText`, so `#My Section`,
 *  `#my-section` and `#My%20Section` all arrive as `my-section`).
 *
 *  Only sees what `tree` covers — a partial tree cannot report a heading below
 *  its end. Callers that must not miss one pass a complete tree; see
 *  `resolveLinkTarget`'s `reach`. */
export function findHeadingBySlug(state: EditorState, tree: Tree, slug: string): number | null {
  if (slug === "") {
    return null;
  }
  let index = SLUG_INDEX_CACHE.get(tree);
  if (index === undefined || index.doc !== state.doc) {
    index = { doc: state.doc, bySlug: buildSlugIndex(state, tree) };
    SLUG_INDEX_CACHE.set(tree, index);
  }
  return index.bySlug.get(slug) ?? null;
}

/** A LinkTarget with the document question answered. The `fragment` arm is gone
 *  — it has become `scroll` (a heading matched; `pos` is where to go),
 *  `no-action` (the document genuinely has no such heading) or
 *  `unresolved-fragment` (the question could not be ANSWERED — see below). Every
 *  other arm passes through untouched, so link-handlers keeps one exhaustive
 *  switch with its per-gate warns intact.
 *
 *  Derived with `Exclude` rather than re-listed so a new LinkTarget arm shows up
 *  here automatically and the consuming switches red until they handle it. */
export type ResolvedLinkTarget =
  | Exclude<LinkTarget, { kind: "fragment" }>
  | { readonly kind: "scroll"; readonly pos: number }
  | { readonly kind: "unresolved-fragment" };

/** How far the resolver may push the parse to answer the document question.
 *
 *  A REQUIRED argument with two named arms rather than a millisecond number
 *  defaulting to 0, because the "0" was load-bearing policy hiding in an omitted
 *  argument: a copy-paste of the click call site into the decoration path
 *  compiled green and silently forced a full parse on every viewport/selection
 *  rebuild. Now each call site has to say which one it is.
 *
 *  - `"viewport-only"` — search the tree as handed. The DECORATION path, which
 *    rebuilds on every viewport and selection change and must never force a
 *    parse there.
 *  - `{ completeWithinMs }` — force a complete parse first (`ensureSyntaxTree`),
 *    spending up to that many milliseconds. The CLICK path, mirroring what
 *    outline-panel.ts does on ITS user-initiated path. */
export type ParseReach = "viewport-only" | { readonly completeWithinMs: number };

/** Answer the document question for `target`.
 *
 *  The `reach` asymmetry between the two consumers is deliberate.
 *  `syntaxTree(state)` only guarantees the viewport (+~100 KB), so in a large
 *  document a heading far below the fold may not be in the tree at all — and a
 *  table-of-contents link to exactly such a heading is this feature's main use
 *  case. So the click forces the parse and the decoration does not.
 *
 *  The cost is paid only for a fragment — a passing-through `external` returns
 *  before any parse work — and the resulting asymmetry fails safe: a far-heading
 *  link may show no pointer yet still work when clicked. That is a
 *  discoverability miss, never a dead click, and the tree catches up as the user
 *  scrolls.
 *
 *  When a budget WAS requested and ran out, a miss is reported as
 *  `unresolved-fragment`, not `no-action`. The two are different facts — "this
 *  document has no such heading" versus "we could not finish looking" — and
 *  collapsing them hid the exact large-document case the budget exists to serve:
 *  a real heading silently produced no scroll and no diagnostic. If the partial
 *  tree DOES find the slug the answer is `scroll` as usual; an exhausted budget
 *  only matters when the search came up empty. */
export function resolveLinkTarget(
  state: EditorState,
  tree: Tree,
  target: LinkTarget,
  reach: ParseReach
): ResolvedLinkTarget {
  if (target.kind !== "fragment") {
    return target;
  }
  let searchTree = tree;
  let budgetExhausted = false;
  if (reach !== "viewport-only") {
    const complete = ensureSyntaxTree(state, state.doc.length, reach.completeWithinMs);
    if (complete === null) {
      budgetExhausted = true;
    } else {
      searchTree = complete;
    }
  }
  const pos = findHeadingBySlug(state, searchTree, target.slug);
  if (pos !== null) {
    return { kind: "scroll", pos };
  }
  return budgetExhausted ? { kind: "unresolved-fragment" } : { kind: "no-action" };
}

/** Why a lookup table rather than `kind === "external" || …`: the switch in
 *  tryOpenLinkAt is exhaustiveness-checked (TS2366), but a boolean `||` chain is
 *  not — a new arm would compile green here and silently answer `false`. A
 *  `Record<ResolvedLinkTarget["kind"], …>` reds with TS2741 the moment the union
 *  grows, so the click and the cursor cannot drift. (This table and the
 *  predicate moved here from link-target.ts when the resolve stage was
 *  introduced: they judge a RESOLVED target now, which is the only form in which
 *  "does this act?" has an answer.) */
const ACTIONABLE_BY_KIND: Record<ResolvedLinkTarget["kind"], boolean> = {
  external: true,
  workspace: true,
  scroll: true,
  oversize: false,
  blocked: false,
  "unopenable-scheme": false,
  "no-action": false,
  "unresolved-fragment": false,
};

/** True for exactly the arms a click ACTS on. Consumers: the click handler (act,
 *  or fall through to a caret move) and the reveal decoration (pointer cursor,
 *  or leave the text cursor). Both call `resolveLinkTarget` first and both read
 *  THIS predicate, which is the whole point of the two-stage split. The
 *  invariant it buys is ONE-DIRECTIONAL: the pointer never over-promises —
 *  whatever it marks, the click acts on. The reverse can fail, and only through
 *  the deliberate parse-budget asymmetry in `resolveLinkTarget` (no pointer, but
 *  the click still works).
 *
 *  Named for the INTENT ("a click does something") rather than the mechanism
 *  ("posts to the host"): `scroll` acts entirely inside the webview. */
export function isActionableLinkTarget(resolved: ResolvedLinkTarget): boolean {
  return ACTIONABLE_BY_KIND[resolved.kind];
}
