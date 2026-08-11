// Resolve a classified link destination against THIS document.
//
// cm/link-target.ts answers "what is this destination?" from the string alone
// and must stay that way (pure, total, no CM state). One arm cannot be answered
// that way: a `#slug` fragment acts only if the document actually has a heading
// with that slug. This module is that second stage, and it is deliberately the
// ONLY place the question is asked — cm/link-handlers.ts (click) and
// cm/decorations/link-reveal.ts (pointer cursor) both consume its output, so
// the affordance cannot drift from the behaviour.
//
// TOTALITY IS A HARD CONTRACT — link-reveal calls this inside a
// DecorationProvider.build(), where a throw permanently deactivates the whole
// inline-reveal layer (see link-target.ts's header). Tree walk + string + Map
// work only; no throwing primitive is reachable from here.
//
// NO-URL POLICY: `slug` is href-derived. Look it up, never log it.

import type { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";

import { collectHeadings, headingText, slugifyHeadingText } from "./headings.js";

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
 *  visible fragment link rebuilds the index once per keystroke. That is accepted
 *  (see the plan's Risks) — outline-panel.ts debounces the identical walk if
 *  this ever needs the same treatment.
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
    // Node span, NOT line.text: a heading nested in a blockquote / list item
    // has its container marks ("> ", "- ") OUTSIDE [from, to).
    const base = slugifyHeadingText(headingText(state.doc.sliceString(from, to)));
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
 *  `resolveLinkTarget`'s `completeParseBudgetMs`. */
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
