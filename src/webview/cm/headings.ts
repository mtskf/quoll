// Single ATX-heading collector shared by the outline builder and the
// heading-increment / duplicate-heading-text lint rules. Each consumer did its
// own `tree.iterate` over the same `ATXHeading{1..6}` match; this is that walk,
// once. Consumers add their own per-heading work (text slice, ancestor-depth
// stack) on top of the returned {level, from, to} list. The Tree type is derived
// from syntaxTree's return type per repo convention (avoids widening the
// @lezer/common direct-dep import surface — see decorations/types.ts).
//
// Also owns the pure heading-TEXT primitives shared by the outline and the
// fragment-link resolver: headingText (strip the ATX syntax) and
// slugifyHeadingText (GitHub-style anchor slug). Both are total string
// functions with no CM dependency beyond the Tree type above.

import type { syntaxTree } from "@codemirror/language";

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
 *  Lives here rather than in outline/build-outline.ts because the outline and
 *  the fragment-link resolver must strip IDENTICALLY — an outline row and a
 *  `#slug` have to name the same heading.
 *
 *  Moved VERBATIM from build-outline.ts, order included: opener first, then the
 *  closing run. lint/rules/duplicate-heading-text.ts keeps its own copy with the
 *  opposite order (and whitespace collapsing, and no `^[ \t]*` indent tolerance)
 *  for a documented CommonMark reason. The two disagree only on `# #`-shaped
 *  empty headings, where this one yields "#" and that one "" — both slug to ""
 *  downstream, so the divergence is inert here. Unifying the copies is a
 *  separate change; do not "fix" the order in passing.
 *
 *  Pure string work: total by contract (see slugifyHeadingText). */
export function headingText(raw: string): string {
  return raw
    .replace(/^[ \t]*#{1,6}(?:[ \t]+|$)/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
}

/** GitHub-STYLE anchor slug for a heading's text: lowercase, drop everything
 *  that is not a letter / number / combining mark / `_` / `-` / whitespace,
 *  then collapse whitespace runs to single hyphens. Unicode-aware
 *  (`\p{L}\p{N}\p{M}`) so a Japanese or accented heading slugs to itself rather
 *  than to the empty string, which is what GitHub does.
 *
 *  "STYLE", not "compatible", and the distinction is load-bearing. This is not
 *  a github-slugger port: no transliteration, and the input is RAW Markdown
 *  source rather than rendered text. Emphasis and inline code come out
 *  identical to GitHub (their marks are punctuation, so they are stripped), but
 *  a link or image inside a heading leaks its destination — `A [link](b)` slugs
 *  to `a-linkb` where GitHub says `a-link`. Accepted: the failure mode is a
 *  fragment link that shows no pointer and stays a caret move, never a dead
 *  click. Slugging rendered text means walking the heading's inline tree and
 *  excluding mark nodes — a separate change with its own tests.
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
