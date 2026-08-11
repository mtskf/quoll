// Single ATX-heading collector shared by the outline builder and the
// heading-increment / duplicate-heading-text lint rules. Each consumer did its
// own `tree.iterate` over the same `ATXHeading{1..6}` match; this is that walk,
// once. Consumers add their own per-heading work (text slice, ancestor-depth
// stack) on top of the returned {level, from, to} list. The Tree type is derived
// from syntaxTree's return type per repo convention (avoids widening the
// @lezer/common direct-dep import surface — see decorations/types.ts).
//
// Also owns the heading-TEXT primitives: headingText (strip the ATX syntax from
// a raw slice — the outline's reader), headingSlugSource (the heading's RENDERED
// content, markup nodes removed — the fragment-link resolver's reader) and
// slugifyHeadingText (GitHub-style anchor slug, applied to either). All three
// are total; only headingSlugSource needs the tree and the document.

import type { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

type Tree = ReturnType<typeof syntaxTree>;

/** Matches Lezer `ATXHeading1`..`ATXHeading6`, capturing the level digit.
 *  Module-private: consumers import `collectHeadings`, not the regex. */
const ATX_HEADING = /^ATXHeading([1-6])$/;

/** Walk `tree` for ATX headings in document order, returning each heading's
 *  level (1..6) and node span `[from, to)`. Descends into every block so
 *  headings nested in blockquotes / list items are included. */
export function collectHeadings(tree: Tree): { level: number; from: number; to: number }[] {
  const headings: { level: number; from: number; to: number }[] = [];
  tree.iterate({
    enter: (node) => {
      const m = ATX_HEADING.exec(node.name);
      if (m) {
        headings.push({ level: Number(m[1]), from: node.from, to: node.to });
      }
    },
  });
  return headings;
}

/** Strip the ATX opener (`#`..`######` and following spaces/tabs) and an
 *  optional closing `#` run from a heading's node-span text, then trim.
 *  Sole consumer: outline/build-outline.ts, which wants the heading's SOURCE
 *  text — an outline row shows the Markdown the user typed. The fragment-link
 *  resolver deliberately does NOT share it; it reads the rendered content via
 *  headingSlugSource below (see that function for why the two must differ).
 *  It still lives here rather than in build-outline.ts because it is the
 *  string half of this module's heading vocabulary.
 *
 *  Moved VERBATIM from build-outline.ts, order included: opener first, then the
 *  closing run. lint/rules/duplicate-heading-text.ts keeps its own copy with the
 *  opposite order (and whitespace collapsing, and no `^[ \t]*` indent tolerance)
 *  for a documented CommonMark reason. TWO of those differences are behavioural,
 *  not merely textual: a `# #`-shaped empty heading yields "#" here and "" there,
 *  and an internal whitespace run survives here (`# A  B` → "A  B") while that
 *  copy collapses it to one space. Both are inert as things stand only because
 *  the copies have DISJOINT consumers — an outline row shows the source as typed,
 *  and the lint rule compares its own outputs to each other — so "inert" is a
 *  property of the call sites, not of the strings. The `^[ \t]*` difference never
 *  fires at all: a Lezer ATXHeading span starts at the `#` (measured: `   # X`
 *  spans from offset 3), so the slice carries no leading indentation. Unifying
 *  the copies is a separate change; do not "fix" the order in passing.
 *
 *  Pure string work: total by contract (see slugifyHeadingText). */
export function headingText(raw: string): string {
  return raw
    .replace(/^[ \t]*#{1,6}(?:[ \t]+|$)/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
}

/** Inline nodes dropped before slugging. The contract is GITHUB PARITY — the
 *  slug should match the anchor GitHub would mint for the same heading — NOT
 *  "whatever Quoll happens to hide". Those two rules agree almost everywhere and
 *  the distinction only shows up in raw HTML, where GitHub wins: `HTMLTag` and
 *  `Comment` are dropped even though no Quoll decoration conceals them, because
 *  `# A <em>x</em> B` is `a-x-b` on GitHub and an anchor a reader copies from
 *  GitHub has to resolve here.
 *
 *  Parity is close, not exact: HTML ENTITIES are not decoded, so `# A &amp; B`
 *  slugs `a-amp-b` where GitHub resolves the entity first and drops the `&` as
 *  punctuation. Dropping `Entity` wholesale would be no better — it would also
 *  swallow `&eacute;`, which GitHub keeps as a letter — so the honest fix is
 *  decoding, and that is not worth carrying for a shape this rare.
 *
 *  Membership measured against the real Lezer GFM tree: `HeaderMark` covers the
 *  opener AND the closing `#` run (which is why headingSlugSource needs no ATX
 *  regex), `LinkMark` covers `[`, `]`, `(`, `)` and an image's `![`, `LinkTitle`
 *  is the `"tooltip"` tail of `[x](u "tooltip")`, and `Comment` /
 *  `ProcessingInstruction` are the raw-HTML forms (`<!-- … -->`, `<? … ?>`)
 *  GitHub omits from an anchor. Content-bearing wrappers (`Link`, `Image`, `StrongEmphasis`,
 *  `InlineCode`, `Autolink`, …) are absent on purpose: excluding a wrapper would
 *  delete the text it wraps.
 *
 *  `URL` is conditional and must NEVER be dropped by name alone — see the
 *  destination gate in headingSlugSource.
 *
 *  Known divergence: a reference link's label survives (`# [a][ref]` slugs
 *  `aref`, GitHub says `a`). Excluding `LinkLabel` would be wrong for an
 *  UNDEFINED reference, which GitHub renders — and slugs — literally, and
 *  telling the two apart means resolving the document's link definitions.
 *  Quoll shows the label either way, so the slug matches what is on screen. */
const SLUG_EXCLUDED_NODES = new Set([
  "HeaderMark",
  "LinkMark",
  "LinkTitle",
  "URL",
  "CodeMark",
  "EmphasisMark",
  "StrikethroughMark",
  "HTMLTag",
  "Comment",
  "ProcessingInstruction",
]);

/** The two node names under which a `URL` is a link/image DESTINATION. Anywhere
 *  else a `URL` node is rendered content, not markup — see the parent gate. */
const URL_DESTINATION_PARENTS = new Set(["Link", "Image"]);

/** The heading at `[from, to)` with its inline MARKUP ranges removed and the
 *  gaps stitched back together — the text GitHub would slug. This, not the raw
 *  source, is what the fragment-link resolver slugs, so `# A [link](b)` is
 *  addressable as `#a-link` (GitHub's answer, and also what a reader of a Quoll
 *  document sees once the syntax is hidden) instead of `#a-linkb`.
 *  headingText cannot do this job: markup removal is a TREE question, and the
 *  outline wants the source text anyway.
 *
 *  "Markup" means SLUG_EXCLUDED_NODES plus the parent gate below — read that
 *  set's contract before adding to it. It is GitHub parity, not "what Quoll
 *  conceals"; the two diverge on raw HTML.
 *
 *  Returns the stitched text unslugged and untrimmed — the caller pipes it
 *  through slugifyHeadingText, which trims and collapses the whitespace the
 *  removed marks leave behind.
 *
 *  TOTAL BY CONTRACT — reachable from a decoration provider via link-resolve.ts.
 *  `sliceString` is the only throwing primitive here, so a span that is not
 *  fully inside `state.doc` (a stale tree over a shortened document — the same
 *  hazard link-resolve.ts's index guard exists for) returns "" rather than
 *  slicing. `tree.iterate` over an out-of-document range does not throw. */
export function headingSlugSource(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number
): string {
  if (from < 0 || to > state.doc.length || from > to) {
    return "";
  }
  let text = "";
  let cursor = from;
  tree.iterate({
    from,
    to,
    enter: (node) => {
      if (!SLUG_EXCLUDED_NODES.has(node.name)) {
        return;
      }
      // `URL` is markup ONLY as a link/image destination, and "destination" is
      // a POSITIONAL fact, not a parental one. GFM emits `URL` for four things:
      //   `[text](dest)`            destination  — parent Link,  prev `(`
      //   `[https://x](dest)`       LINK TEXT    — parent Link,  prev `[`
      //   `![https://x](u.png)`     ALT TEXT     — parent Image, prev `![`
      //   `<https://x>` / bare      content      — parent Autolink / the heading
      // Autolinking fires inside link text and alt text too, so the first two
      // share a parent and only the preceding LinkMark tells them apart. Gating
      // on the parent alone dropped the visible text of `# [https://x](dest)`
      // along with its destination, leaving the empty slug — a heading with no
      // anchor at all, which is precisely the regression this gate was added to
      // close. Match on the `(` instead: everything else is content.
      if (node.name === "URL") {
        const parent = node.node.parent;
        const prev = node.node.prevSibling;
        const isDestination =
          parent !== null &&
          URL_DESTINATION_PARENTS.has(parent.name) &&
          prev !== null &&
          prev.name === "LinkMark" &&
          state.doc.sliceString(prev.from, prev.to) === "(";
        if (!isDestination) {
          return;
        }
      }
      if (node.from > cursor) {
        text += state.doc.sliceString(cursor, node.from);
      }
      // Math.max, not a bare assign: an excluded node can sit inside another
      // excluded node's range (the enter order is pre-order, so the parent is
      // consumed first), and a bare assign would rewind the cursor and re-emit
      // bytes already written.
      cursor = Math.max(cursor, node.to);
    },
  });
  if (cursor < to) {
    text += state.doc.sliceString(cursor, to);
  }
  return text;
}

/** GitHub-STYLE anchor slug for a heading's text: lowercase, drop everything
 *  that is not a letter / number / combining mark / `_` / `-` / whitespace,
 *  then collapse whitespace runs to single hyphens. Unicode-aware
 *  (`\p{L}\p{N}\p{M}`) so a Japanese or accented heading slugs to itself rather
 *  than to the empty string, which is what GitHub does.
 *
 *  "STYLE", not "compatible", and the distinction is load-bearing. This is not
 *  a github-slugger port: no transliteration. It also makes no claim about WHAT
 *  it is handed — it slugs whatever string arrives. Feeding it raw source would
 *  leak a link's destination (`A [link](b)` → `a-linkb` where GitHub says
 *  `a-link`); that is why the fragment-link resolver feeds it headingSlugSource
 *  (markup nodes removed) and not headingText.
 *
 *  The duplicate-heading counter is NOT here: it is positional, so it belongs
 *  to the index in link-resolve.ts, not to a per-string function.
 *
 *  NFC first, because both sides run through this one function and they can
 *  arrive in different normalisation forms: a heading pasted from macOS may be
 *  NFD (`e` + U+0301) while the fragment someone types is NFC (`é`). Without
 *  the normalise those are different strings and the link silently never
 *  matches. `String.prototype.normalize` is total, so it costs no totality.
 *
 *  TOTAL BY CONTRACT — reachable from a decoration provider via
 *  link-resolve.ts. Regex + string methods only; nothing here can throw. */
export function slugifyHeadingText(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}
