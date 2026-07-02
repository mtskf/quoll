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

// `@lezer/common` is a transitive-only, un-hoisted pnpm dep; derive the tree
// type from syntaxTree's return type instead of importing it (repo convention —
// see src/webview/cm/decorations/types.ts).
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

const ATX_HEADING = /^ATXHeading([1-6])$/;

/** Strip the ATX opener (`#`..`######` and following spaces/tabs) and an
 *  optional closing `#` run from a heading's node-span text, then trim. */
function headingText(raw: string): string {
  return raw
    .replace(/^[ \t]*#{1,6}(?:[ \t]+|$)/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .trim();
}

/** Walk `tree` for ATX headings in document order. Descends into every block so
 *  headings nested in blockquotes / list items are included; skips a heading's
 *  own inline children (headings never contain headings). */
export function extractOutline(state: EditorState, tree: Tree): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  const ancestors: number[] = []; // levels of open ancestors, strictly increasing
  tree.iterate({
    enter: (node) => {
      const match = ATX_HEADING.exec(node.name);
      if (!match) {
        return; // descend — a heading may be nested in this block
      }
      const level = Number(match[1]);
      const docLine = state.doc.lineAt(node.from);
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] >= level) {
        ancestors.pop();
      }
      const depth = ancestors.length;
      ancestors.push(level);
      headings.push({
        level,
        depth,
        // Node span, NOT line.text: a heading nested in a blockquote/list has
        // its container marks ("> " / "- ") OUTSIDE [node.from, node.to).
        text: headingText(state.doc.sliceString(node.from, node.to)),
        line: docLine.number,
        from: docLine.from,
      });
      return false; // headings don't contain headings — skip inline children
    },
  });
  return headings;
}
