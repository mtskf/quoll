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
import { markdownKeymap, markdownLanguage, pasteURLAsLink } from "@codemirror/lang-markdown";
import {
  foldNodeProp,
  foldService,
  Language,
  LanguageSupport,
  syntaxTree,
} from "@codemirror/language";
import { Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { MarkdownExtension, MarkdownParser } from "@lezer/markdown";

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

// SyntaxNode without a direct @lezer/common import (transitive-only, un-hoisted
// pnpm dep — supply-chain default-deny). Derive it from syntaxTree's return type,
// the established webview idiom (see decorations/block-style.ts).
type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

// lang-markdown's heading-section foldService is NOT exported and reads a PRIVATE
// `headingProp` NodeProp we cannot reach. Re-implement it by node NAME (ATX/Setext
// heading level): the fold runs from the end of a heading's line to the end of its
// section (the line before the next same-or-higher heading). This is the ONLY
// source of heading folds — the base commonmark `foldNodeProp` deliberately
// returns `undefined` for headings, so without this service a heading shows no
// chevron. Pinned by cm-markdown-language.test.ts (byte-identical to upstream),
// cm-fold-delegation.test.ts, and cm-fold-blockquote.test.ts (heading-in-blockquote).
function headingLevel(node: SyntaxNode): number | null {
  const match = /^(?:ATX|Setext)Heading(\d)$/.exec(node.type.name);
  return match ? Number(match[1]) : null;
}

function sectionEnd(headerNode: SyntaxNode, level: number): number {
  let last = headerNode;
  for (;;) {
    const next: SyntaxNode | null = last.nextSibling;
    if (!next) {
      break;
    }
    const nextLevel = headingLevel(next);
    if (nextLevel !== null && nextLevel <= level) {
      break;
    }
    last = next;
  }
  return last.to;
}

const headerIndent = foldService.of((state, start, end) => {
  for (
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(end, -1);
    node;
    node = node.parent
  ) {
    if (node.from < start) {
      break;
    }
    const level = headingLevel(node);
    if (level === null) {
      continue;
    }
    const upto = sectionEnd(node, level);
    if (upto > end) {
      return { from: end, to: upto };
    }
  }
  return null;
});

/** The editor's Markdown LanguageSupport, built DIRECTLY from `markdownLanguage`
 *  (GFM base) instead of via `markdown()`, whose runtime-default `htmlTagLanguage`
 *  unconditionally drags @codemirror/lang-html → @lezer/javascript/html/css +
 *  lang-css/lang-javascript + @codemirror/autocomplete (~148 KB of the shipped
 *  bundle) into the webview. Quoll treats raw HTML as opaque/inert source, so that
 *  stack only bought nested HTML-tag highlighting + tag autocompletion inside
 *  Markdown — a deliberate product loss (recorded in the PR). We reproduce exactly
 *  what `markdown()` builds MINUS that stack:
 *    - parser: markdownLanguage.parser + nonFoldableBlocks (our fold subtraction),
 *      with NO parseCode wrapper (no nested HTML/code sub-parser referenced).
 *    - data: markdownLanguage.data REUSED — markdownKeymap's commands and
 *      pasteURLAsLink call markdownLanguage.isActiveAt(), which compares the
 *      languageDataProp facet identity, so the editor language MUST carry the
 *      same `data` facet to be recognised as active (mkLang does the same).
 *    - support: headerIndent (heading folds), pasteURLAsLink, and markdownKeymap
 *      at Prec.high — the three support extensions `markdown()` adds that we keep.
 *  Mounted by editor.ts; the fold + keymap + paste contracts are pinned by
 *  cm-markdown-language / cm-fold-blockquote / cm-fold-delegation. */
export function quollMarkdownLanguage(): LanguageSupport {
  // markdownLanguage.parser is statically typed as the abstract @lezer/common
  // Parser (via Language.parser); the runtime instance is a MarkdownParser, which
  // is the only thing exposing `.configure`. Narrow to it (same package already
  // imported for MarkdownExtension) — no cast to a fresh dependency.
  const parser = (markdownLanguage.parser as MarkdownParser).configure(nonFoldableBlocks);
  const language = new Language(markdownLanguage.data, parser, [], "markdown");
  return new LanguageSupport(language, [
    headerIndent,
    pasteURLAsLink,
    Prec.high(keymap.of(markdownKeymap)),
  ]);
}
