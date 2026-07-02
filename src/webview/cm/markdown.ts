// The editor's Markdown language config — the SINGLE source of the live
// editor's language (editor.ts mounts quollMarkdownLanguage(); the fold
// contract test imports the same). Parser policy lives here, not in the
// fold-UI module (cm/fold/index.ts only mounts the gutter).
//
// `nonFoldableBlocks` SUBTRACTS Blockquote, Paragraph, and code blocks
// (FencedCode + indented CodeBlock) from lang-markdown's broad Block folds.
// lang-markdown's `foldNodeProp` folds EVERY non-Document/non-heading/
// non-list-container `Block`, so a blockquote — and the multi-line `Paragraph`
// inside it, which yields the SAME range — both get a chevron, as do code
// blocks. A `null`-returning `foldService` cannot subtract that: CM's
// `foldable()` falls through to `syntaxFolding`/`foldNodeProp` when every
// service returns null. The only seam that makes `foldable()` return null on
// these lines is overriding the node's own `foldNodeProp` to return null.
// Overriding `Paragraph` too is REQUIRED (the inner paragraph re-folds the
// blockquote) and intended (a standalone multi-line paragraph is not in the
// keep-foldable set). Code blocks are excluded by request — a code block does
// not need a fold affordance. The keep-foldable set is therefore headings,
// lists, and tables; everything else is subtracted here.
//
// This is a NODE-TYPE override. A blockquote that wraps a still-foldable
// structure (a nested list, a table, a heading) keeps that inner fold — the
// inner node owns it, consistent with "keep lists/tables/headings foldable"
// (pinned in cm-fold-blockquote.test.ts). A blockquote wrapping ONLY a code
// block shows no chevron (the fenced block is subtracted too). The fn returns
// `null`, not `undefined`: foldNodeProp's value type is `(node, state) =>
// {from,to} | null`, so `undefined` fails strict type-check. This rides
// lang-markdown's PUBLIC API but depends on its 6.5.0 fold *behaviour*;
// cm-fold-blockquote.test.ts detects a future upgrade that re-enables a
// subtracted chevron (it is NOT immunity).
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import type { LanguageSupport } from "@codemirror/language";
import { foldNodeProp } from "@codemirror/language";
import type { MarkdownExtension } from "@lezer/markdown";

export const nonFoldableBlocks: MarkdownExtension = {
  props: [
    foldNodeProp.add({
      Blockquote: () => null,
      Paragraph: () => null,
      FencedCode: () => null,
      CodeBlock: () => null,
    }),
  ],
};

/** The editor's Markdown LanguageSupport: lang-markdown's GFM base minus the
 *  Blockquote / Paragraph / code-block fold subtraction (headings, lists, and
 *  tables stay foldable). Mounted by editor.ts; pinned by
 *  cm-fold-blockquote.test.ts. */
export function quollMarkdownLanguage(): LanguageSupport {
  return markdown({ base: markdownLanguage, extensions: nonFoldableBlocks });
}
