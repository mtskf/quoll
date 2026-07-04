// The editor's Markdown language config — the SINGLE source of the live
// editor's language (editor.ts mounts quollMarkdownLanguage(); the fold
// contract test imports the same). Parser policy lives here, not in the
// fold-UI module (cm/fold/index.ts only mounts the gutter).
//
// `nonFoldableBlocks` SUBTRACTS Blockquote, Paragraph, code blocks
// (FencedCode + indented CodeBlock), and GFM Table from lang-markdown's broad
// Block folds. lang-markdown's `foldNodeProp` folds EVERY non-Document/
// non-heading/non-list-container `Block`, so a blockquote — and the multi-line
// `Paragraph` inside it, which yields the SAME range — both get a chevron, as
// do code blocks and tables. A `null`-returning `foldService` cannot subtract
// that: CM's `foldable()` falls through to `syntaxFolding`/`foldNodeProp` when
// every service returns null. The only seam that makes `foldable()` return null
// on these lines is overriding the node's own `foldNodeProp` to return null.
// Overriding `Paragraph` too is REQUIRED (the inner paragraph re-folds the
// blockquote) and intended (a standalone multi-line paragraph is not in the
// keep-foldable set). Code blocks are excluded by request — a code block does
// not need a fold affordance. A GFM table renders as a display-only block widget
// (cm/table/), which is not a foldable construct, so a chevron on its rows is
// meaningless — `Table` is subtracted too. The keep-foldable set is therefore
// headings and lists; everything else is subtracted here.
//
// This is a NODE-TYPE override. A blockquote that wraps a still-foldable
// structure (a nested list, a heading) keeps that inner fold — the inner node
// owns it, consistent with "keep lists/headings foldable" (pinned in
// cm-fold-blockquote.test.ts). A blockquote wrapping ONLY a code block or ONLY a
// table shows no chevron (both are subtracted too). A table nested in a list
// item leaves the ListItem fold intact (the chevron sits on the list's marker
// line, never on a table row) — EXCEPT the tight shape where the table starts on
// the marker line itself (`- | a | b |\n…`): there the table's block widget
// swallows the marker, so a ListItem foldNodeProp override (listItemFold below)
// suppresses that lone chevron. The fn returns
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
import { type EditorState, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { MarkdownExtension, MarkdownParser } from "@lezer/markdown";

// SyntaxNode without a direct @lezer/common import (transitive-only, un-hoisted
// pnpm dep — supply-chain default-deny). Derive it from syntaxTree's return type,
// the established webview idiom (see decorations/block-style.ts).
type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

// A ListItem's first content node — the leading ListMark (`-` / `1.`) is skipped
// so the caller inspects the item's actual body (a Paragraph, a Table, a nested
// list…), not the marker.
function firstContentChild(node: SyntaxNode): SyntaxNode | null {
  const first = node.firstChild;
  return first?.type.name === "ListMark" ? first.nextSibling : first;
}

// ListItem fold: re-implements lang-markdown's default Block range (from the end
// of the item's first line to the item end) EXCEPT when the item's first content
// child is a GFM Table that starts on the marker line. In that tight shape
// (`- | a | b |\n  | - | - |\n…`) tableBlockField line-snaps its block widget to
// the marker-line start (blockFrom = lineAt(Table.from).from), so the widget
// SWALLOWS the `-`/`1.` marker and the ListItem chevron would visually land on the
// table — a meaningless affordance. Returning null suppresses that lone chevron;
// every genuine list fold (a table on a continuation line, a plain multi-line
// body) keeps the default range. lang-markdown folds ListItem via its broad
// `type => …` Block foldNodeProp, and this object-form `.add` OVERRIDES that per
// node type (same mechanism as the Table/Paragraph/Blockquote subtractions below).
// Pinned by cm-fold-blockquote.test.ts.
function listItemFold(node: SyntaxNode, state: EditorState): { from: number; to: number } | null {
  const content = firstContentChild(node);
  if (
    content?.type.name === "Table" &&
    state.doc.lineAt(content.from).from === state.doc.lineAt(node.from).from
  ) {
    return null;
  }
  return { from: state.doc.lineAt(node.from).to, to: node.to };
}

export const nonFoldableBlocks: MarkdownExtension = {
  props: [
    foldNodeProp.add({
      Blockquote: () => null,
      Paragraph: () => null,
      FencedCode: () => null,
      CodeBlock: () => null,
      Table: () => null,
      ListItem: listItemFold,
    }),
  ],
};

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
