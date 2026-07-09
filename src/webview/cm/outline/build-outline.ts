// Pure ATX-heading extraction for the document outline.
//
// CM-native: walk the Lezer syntax tree for ATXHeading{1..6} nodes rather than
// regexing raw lines. The tree walk is what correctly excludes `#`-prefixed
// lines inside fenced/indented code (Lezer emits FencedCode > CodeText, not
// ATXHeading). ATX headings ALSO nest inside Blockquote / ListItem (verified:
// "> # x" => Blockquote > ATXHeading1), so the walk descends into every block —
// it does NOT early-exit non-heading subtrees, which would silently drop those
// nested headings.
//
// Pure: this module takes an already-obtained tree and never decides WHEN or
// with what parse budget to produce it (that policy lives in outline-panel.ts).
// View-only: callers read these entries and never mutate the document.

import type { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { collectHeadings } from "../headings.js";

// `@lezer/common` is a direct dep as of PR #66 (for the lint incremental
// parser's `TreeFragment`); derive the tree type from syntaxTree's return type
// instead of importing it to avoid widening the direct-dep import surface (repo
// convention — see src/webview/cm/decorations/types.ts).
type Tree = ReturnType<typeof syntaxTree>;

/** One ATX heading, in document order. Identity is positional (`from`), never a
 *  slugged text, so duplicate heading text yields distinct entries. */
export interface OutlineHeading {
  /** Heading level 1..6, from the `ATXHeading{1..6}` node name. */
  level: number;
  /** 0-based render/nesting depth, computed via a level stack so a skipped
   *  level (e.g. h1 then h3) collapses to contiguous indentation. */
  depth: number;
  /** Heading text: the leading `#` opener and any closing `#` run stripped,
   *  then trimmed. May be empty for a bare `#`. */
  text: string;
  /** 1-based source line number (CodeMirror `Line.number`). */
  line: number;
  /** Document offset of the heading line start — the jump target and the
   *  positional identity that disambiguates duplicate text. */
  from: number;
}

/** Strip the ATX opener (`#`..`######` and following spaces/tabs) and an
 *  optional closing `#` run from a heading's node-span text, then trim. */
function headingText(raw: string): string {
  return raw
    .replace(/^[ \t]*#{1,6}(?:[ \t]+|$)/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
}

/** Build outline entries from `collectHeadings(tree)`'s document-order ATX
 *  heading list (which descends into every block, so headings nested in
 *  blockquotes / list items are included). */
export function extractOutline(state: EditorState, tree: Tree): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const ancestors: number[] = []; // levels of open ancestors, strictly increasing
  for (const { level, from, to } of collectHeadings(tree)) {
    const docLine = state.doc.lineAt(from);
    while (ancestors.length > 0 && ancestors[ancestors.length - 1] >= level) {
      ancestors.pop();
    }
    const depth = ancestors.length;
    ancestors.push(level);
    headings.push({
      level,
      depth,
      // Node span, NOT line.text: a heading nested in a blockquote/list has its
      // container marks ("> " / "- ") OUTSIDE [from, to).
      text: headingText(state.doc.sliceString(from, to)),
      line: docLine.number,
      from: docLine.from,
    });
  }
  return headings;
}
