import type { syntaxTree } from "@codemirror/language";

// The Lezer tree type, derived from syntaxTree's return type per repo
// convention (avoids widening the @lezer/common direct-dep import surface —
// mirrors headings.ts and types.ts).
type Tree = ReturnType<typeof syntaxTree>;

// A single Markdown Paragraph's prose text, with its ABSOLUTE start offset into
// the text the tree was parsed from. `text` is the paragraph slice with inline
// markup that must not be scanned as prose (inline code + link/autolink URLs)
// MASKED to spaces of equal length, so `from + localOffset` still points at the
// real byte a rule wants to flag. Same length as the raw slice ⇒ offset-stable.
export type ProseParagraph = { readonly from: number; readonly text: string };

// Inline nodes whose contents are NOT prose and would otherwise trip the prose
// rules: `InlineCode` (`` `foo_ed` `` reads as passive/filler) and `URL` (a link
// destination or autolink inflates long-sentence word counts and can match
// filler substrings). Masked to spaces so the offsets of surrounding real prose
// are preserved. Emphasis / bold MARKERS are intentionally left in for v1 (low
// false-positive value); adding them later is a change to this collector only.
const MASKED_NODES = new Set(["InlineCode", "URL"]);

// Collect every Paragraph node's prose text (inline-code + URL spans masked),
// in document order, each carrying its absolute start offset. Paragraphs nested
// in blockquotes / list items ARE included (they are still `Paragraph` nodes);
// headings, code fences, tables, and frontmatter are NOT (they are not
// `Paragraph` nodes), which is the whole basis of the prose rules' precision.
//
// `text` here is whatever the caller parsed the tree from. The prose rules run
// as ordinary body `LintRule`s, so they pass `ctx.text` (the frontmatter-sliced
// body) and `ctx.tree` (the body tree); the offsets returned are therefore
// body-relative and the engine re-adds `bodyStart` once, exactly like every
// other body rule. Callers must NOT add any document-absolute shift themselves.
export function collectProseParagraphs(tree: Tree, text: string): ProseParagraph[] {
  const paragraphs: ProseParagraph[] = [];
  tree.iterate({
    enter: (node) => {
      if (node.name !== "Paragraph") {
        return undefined; // descend (into blockquotes / list items) to find paragraphs
      }
      const from = node.from;
      const to = node.to;
      // Code units of the paragraph slice; masked spans are overwritten with
      // spaces. Splitting to a code-unit array keeps masking offset-exact (a
      // fully-masked span replaces both halves of any surrogate pair inside it,
      // so no half-pair is ever left dangling; prose outside spans is untouched).
      const chars = text.slice(from, to).split("");
      // Bounded sub-walk of this paragraph's own inline children only.
      tree.iterate({
        from,
        to,
        enter: (child) => {
          if (!MASKED_NODES.has(child.name)) {
            return undefined;
          }
          // Clamp to the paragraph span (defensive: a node the walk surfaces
          // could in principle straddle the boundary) so the slice indices stay
          // in range and masking never throws.
          const start = Math.max(child.from, from) - from;
          const end = Math.min(child.to, to) - from;
          for (let i = start; i < end; i++) {
            chars[i] = " ";
          }
          return undefined;
        },
      });
      paragraphs.push({ from, text: chars.join("") });
      return false; // a Paragraph has no nested Paragraph — skip its subtree in the outer walk
    },
  });
  return paragraphs;
}

// Count prose WORDS in a sentence/segment: runs that contain a letter or digit,
// allowing internal apostrophes / hyphens (so "isn't" and "well-known" count
// once). Deliberately NOT a whitespace split — masked-span remnants (a masked
// autolink leaves `<    >`, a masked link URL leaves `[x](` / `)`) would
// otherwise count as words and inflate the total. Shared by long-sentence.
export function countWords(text: string): number {
  const words = text.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return words ? words.length : 0;
}
