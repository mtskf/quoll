import { ensureSyntaxTree, language } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";

import { caretInCode } from "../list/list-tree.js";
import { htmlToMarkdown } from "./html-to-markdown.js";

function blockPrefix(before: string): string {
  if (before === "" || before.endsWith("\n\n")) {
    return "";
  }
  return before.endsWith("\n") ? "\n" : "\n\n";
}

function blockSuffix(after: string): string {
  if (after === "") {
    return "\n";
  }
  if (after.startsWith("\n\n")) {
    return "";
  }
  return after.startsWith("\n") ? "\n" : "\n\n";
}

/** The inline nodes of `tree` that lie within `[start, end)`, as position-relative
 *  `name@from-to` keys — or `null` when an inline node CROSSES either edge. Block
 *  nodes (lezer-markdown puts every one, Document and Paragraph included, in the
 *  "Block" group) are only descended through: the question is about inline syntax. */
function inlineNodesWithin(tree: Tree, start: number, end: number): string[] | null {
  const keys: string[] = [];
  let crosses = false;
  tree.iterate({
    enter: (node) => {
      if (crosses || node.to <= start || node.from >= end) {
        return false;
      }
      if (node.type.is("Block")) {
        return;
      }
      if (node.from >= start && node.to <= end) {
        keys.push(`${node.name}@${node.from - start}-${node.to - start}`);
        return;
      }
      if (node.from > start || node.to < end) {
        crosses = true; // starts before the range and ends inside it, or vice versa
        return false;
      }
      // An inline node enclosing the whole range (pasting into a link label or an
      // emphasis span): nesting, not interference — descend.
    },
  });
  return crosses ? null : keys;
}

/** May the converted fragment go in at the caret as-is, instead of as its own
 *  block? Only a single paragraph, and only when the editor's own parser reads it
 *  the same way in place as alone: the text around the selection must neither
 *  reach into the fragment (`!` before a link makes an image, a trailing `\`
 *  escapes the first marker, a `*` merges with an emphasis run) nor leave its
 *  syntax unparsed — CommonMark flanking rejects `hello**(a)**world`, a run
 *  preceded by a letter and followed by punctuation, so that bold would show as
 *  literal `**`. Asking the parser rather than restating flanking rules is what
 *  keeps every such case covered by one test.
 *
 *  Every "no" falls back to the block insert, which is always safe: no Markdown
 *  language loaded, no tree reaching the end of that run within 50 ms, a
 *  multi-block fragment, any difference in place.
 *
 *  "In place" is the top-level block(s) the selection sits in or between, extended
 *  each way through every neighbour that no blank line separates, as whole lines
 *  from the editor's own tree. Blocks, not the selection's line: an unclosed `**` on
 *  an earlier line of the same paragraph pairs with the fragment. Through every
 *  unseparated neighbour, because a paste can dissolve its block into the next one
 *  and that merge chains (a heading turned paragraph text cannot be interrupted by
 *  indented code, so the paragraph after that joins too). Up to a blank line,
 *  because the leaf block that ends up holding the fragment cannot cross one, and
 *  any container that does (a loose list, a fence) is a single top-level node, read
 *  as far as the tree reaches. Whole lines, because a block node starts at its first
 *  non-space character and the indentation it skips is significant. Not the whole
 *  document: CM's background parse stops about 100 KB past the viewport, so a tree
 *  for all of it is never on hand in a large file and 50 ms cannot build one — every
 *  paste there would fall back to the block insert. The tree is asked for only up to
 *  the end of the run after the selection. ⚠️ That the blank-line bound suffices is
 *  argued, not proven, and a backward chain of more than one block is believed
 *  unable to change the answer (blocks before the selection's are fixed by earlier
 *  lines), so that part of the walk is not pinned on its own. The whole-document pin
 *  in cm-rich-html-paste.test.ts is the contract. */
function insertsInline(state: EditorState, from: number, to: number, md: string): boolean {
  const parser = state.facet(language)?.parser;
  if (!parser) {
    return false;
  }
  const alone = parser.parse(md);
  const paragraph = alone.topNode.firstChild;
  if (
    paragraph?.name !== "Paragraph" ||
    paragraph.from !== 0 ||
    paragraph.to !== md.length ||
    paragraph.nextSibling !== null
  ) {
    return false;
  }
  // The walk below reaches no further than the unseparated run after the selection
  // (past the gap, if the selection sits in one). A partial tree force-finishes its
  // last container, which would cut the walk short, so the tree must cover that run.
  let bound = state.doc.lineAt(to);
  while (bound.to < state.doc.length && bound.text.trim() === "") {
    bound = state.doc.line(bound.number + 1);
  }
  while (bound.to < state.doc.length && bound.text.trim() !== "") {
    bound = state.doc.line(bound.number + 1);
  }
  const tree = ensureSyntaxTree(state, bound.to, 50);
  if (!tree) {
    return false;
  }
  const top = tree.topNode;
  // No blank line between `a` and the later `b`.
  const touches = (a: SyntaxNode, b: SyntaxNode) =>
    state.doc.lineAt(a.to).number + 1 >= state.doc.lineAt(b.from).number;
  let firstBlock = top.childBefore(from);
  while (firstBlock?.prevSibling && touches(firstBlock.prevSibling, firstBlock)) {
    firstBlock = firstBlock.prevSibling;
  }
  let lastBlock = top.childAfter(to);
  while (lastBlock?.nextSibling && touches(lastBlock, lastBlock.nextSibling)) {
    lastBlock = lastBlock.nextSibling;
  }
  const contextFrom = firstBlock ? state.doc.lineAt(firstBlock.from).from : 0;
  const contextTo = lastBlock ? state.doc.lineAt(lastBlock.to).to : state.doc.length;
  const head = state.doc.sliceString(contextFrom, from);
  const tail = state.doc.sliceString(to, contextTo);
  const want = inlineNodesWithin(alone, 0, md.length);
  const got = inlineNodesWithin(
    parser.parse(head + md + tail),
    head.length,
    head.length + md.length
  );
  return want !== null && got !== null && got.join() === want.join();
}

/** Freeze conversion bytes, but decide inline placement against live neighbours. */
export function decideRichPaste(
  state: EditorState,
  html: string,
  plainFallback = "",
  forceBlock = false
) {
  const converted = htmlToMarkdown(html);
  if (converted === null) {
    return null;
  }
  const md = converted.markdown;
  const { from, to } = state.selection.main;
  return {
    from,
    to,
    emittedMarkdownSyntax: converted.emittedMarkdownSyntax,
    render: (live: EditorState, start: number, end: number) => {
      if (caretInCode(live, start) || caretInCode(live, end)) {
        return plainFallback;
      }
      return !forceBlock && insertsInline(live, start, end, md)
        ? md
        : blockPrefix(live.doc.sliceString(0, start)) + md + blockSuffix(live.doc.sliceString(end));
    },
  };
}
