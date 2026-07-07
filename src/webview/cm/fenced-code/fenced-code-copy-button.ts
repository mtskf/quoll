// Fenced-code "copy code" button: a selection-INDEPENDENT overlay pinned to the
// top-right of every rendered fenced code block — top-level AND blockquote-/
// list-NESTED. Display-only — the document bytes are never mutated, so the
// source round-trips identically.
//
// fencedCodeBody is the copy payload: the code BETWEEN the opening fence line
// (which carries the ```lang language tag) and the closing fence line, with any
// blockquote/list continuation prefix stripped per line (see below). CodeMirror's
// in-memory document is always LF-joined (the line-separator facet handles
// serialization), so the copied text is the canonical code body regardless of
// the file's on-disk EOL.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, type Line, RangeSetBuilder, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { BuildContext } from "../decorations/types.js";
import { CopyButtonWidget } from "./fenced-code-copy-button-widget.js";

// `@lezer/common` is a direct dep as of PR #66 (for the lint incremental
// parser's `TreeFragment`); derive SyntaxNode from syntaxTree's return type
// rather than importing it to keep the direct-dep surface narrow. Same strategy
// as decorations/types.ts / list-geometry.ts. syntaxTree is a VALUE import (the
// build below calls it at runtime) but still backs these type aliases.
type Tree = ReturnType<typeof syntaxTree>;
type SyntaxNode = Tree["topNode"];

/** Strip up to `max` leading ASCII spaces (CommonMark removes up to the opening
 *  fence's indentation from each content line of an indented fenced block). A
 *  no-op for the common unindented fence (`max === 0`); stops early on a line
 *  with fewer leading spaces (e.g. a blank line). */
function stripLeadingSpaces(text: string, max: number): string {
  let i = 0;
  while (i < max && i < text.length && text[i] === " ") {
    i++;
  }
  return text.slice(i);
}

/** Absolute offset of a blockquote open-fence line's content margin — the point
 *  past the `> ` continuation prefix (nested `> > ` included) where the fence's
 *  own indent begins. Consumes CommonMark blockquote markers greedily: each `>`
 *  (after up to 3 spaces of indentation) plus one optional following space; the
 *  residual spaces from here to the fence mark are the fence indent. */
function blockquoteContentMargin(line: Line): number {
  const { text } = line;
  let i = 0;
  for (;;) {
    let j = i;
    let spaces = 0;
    while (spaces < 3 && text[j] === " ") {
      j++;
      spaces++;
    }
    if (text[j] !== ">") {
      break;
    }
    j++; // the `>` marker
    if (text[j] === " ") {
      j++; // one optional space is part of the marker, not the code
    }
    i = j;
  }
  return line.from + i;
}

/** How many leading spaces to strip from each body line so the copied payload is
 *  the code, not the fence's structural indent. Container-dependent (see the
 *  {@link fencedCodeBody} header): the whole open-line indent for a top-level
 *  fence; the indent past the blockquote content margin for a blockquote-nested
 *  fence; 0 for a list-nested / other fence (Lezer already stripped it). Measured
 *  on the OPEN line, so a blank / bare-`>` body line never skews the amount. */
function fenceIndentToStrip(doc: Text, node: SyntaxNode): number {
  const parent = node.parent;
  if (parent === null) {
    return 0;
  }
  const openLine = doc.lineAt(node.from);
  if (parent.name === "Document") {
    return node.from - openLine.from;
  }
  if (parent.name === "Blockquote") {
    return Math.max(0, node.from - blockquoteContentMargin(openLine));
  }
  return 0;
}

/** The code body of a `FencedCode` node — the code between the fences (fence and
 *  language-tag lines excluded), structural continuation prefix removed; "" when
 *  the block has no body. Works for both backtick (```` ``` ````) and tilde
 *  (`~~~`) fences.
 *
 *  The body is the concatenation of the node's `CodeText` children. Lezer emits
 *  CodeText with the per-line continuation prefix already EXCLUDED — a
 *  blockquote `> ` (a sibling `QuoteMark`) or a list-indent on a nested fence's
 *  body lines sits OUTSIDE CodeText — so a nested block's payload is the code,
 *  not the `>`/indent structure, with no per-line slicing here. CodeText is also
 *  bounded by the real close-fence token, so (unlike a `node.to`-derived span) it
 *  cannot overshoot a trailing line (quoll-lezer-table-to-overshoots-trailing-line).
 *
 *  Fence-indent strip: CommonMark removes the open fence's own indentation from
 *  every body line. Lezer leaves that indentation inside CodeText for a top-level
 *  fence AND for a fence nested directly in a blockquote (the `> ` continuation is
 *  a fixed-width marker, independent of the fence indent, so any extra indent
 *  before the fence leaks into the body), so
 *  {@link fenceIndentToStrip} finishes the CommonMark strip for both — measuring
 *  the fence indent from the container's content margin (the open line only, so a
 *  bare-`>`/blank body line can't skew it) so genuine code indentation past the
 *  fence is preserved. A list-nested fence needs no strip: Lezer already folds an
 *  indented list-fence's inner indent into the continuation margin. */
export function fencedCodeBody(state: EditorState, node: SyntaxNode): string {
  const doc = state.doc;
  let body = "";
  for (const codeText of node.getChildren("CodeText")) {
    body += doc.sliceString(codeText.from, codeText.to);
  }
  // An UNCLOSED fence (one CodeMark — the open fence runs to EOF) ends its last
  // CodeText with the document's terminating newline, which a CLOSED fence's
  // CodeText excludes (the close-fence line is the body terminator). Drop that
  // one phantom newline so a mid-typing block copies the code, not a trailing
  // blank line that exists only because the close fence isn't there yet — this
  // matches the closed-block payload (and the pre-CodeText line-based output). A
  // closed block keeps any trailing "\n" (a genuine trailing blank body line).
  if (node.getChildren("CodeMark").length < 2 && body.endsWith("\n")) {
    body = body.slice(0, -1);
  }
  // Strip the open fence's own indentation from each body line (CommonMark). The
  // amount is container-dependent (see fenceIndentToStrip) and measured on the
  // OPEN line, so a bare-`>`/blank body line can't skew it. 0 → no-op (the common
  // unindented fence, and every list-nested fence).
  const fenceIndent = fenceIndentToStrip(doc, node);
  if (fenceIndent === 0) {
    return body;
  }
  return body
    .split("\n")
    .map((line) => stripLeadingSpaces(line, fenceIndent))
    .join("\n");
}

/** The current copy payload of the fenced block whose OPEN line begins at
 *  `openFrom`, or null when no such block exists there (it was deleted / reshaped
 *  since the widget was built). This is the LAZY, click-time resolution: the body
 *  is a tree-walk of the LIVE state rather than a string materialised into the
 *  widget on every rebuild — so typing inside a large block no longer allocates
 *  its (multi-hundred-KB) body per keystroke, yet the button still copies the
 *  CURRENT body because the walk reads the live tree. `openFrom` is the widget's
 *  eq key, recomputed on every rebuild ({@link buildCopyButtons}), so it is always
 *  the live open-line offset: a body edit leaves it fixed (DOM reused), an edit
 *  above the block shifts it (DOM rebuilt). Scopes the walk to the single open
 *  line, matching {@link buildCopyButtons}'s own anchor rule
 *  (`doc.lineAt(node.from).from`) so a blockquote-/list-nested fence still resolves. */
export function fencedCodeBodyAt(state: EditorState, openFrom: number): string | null {
  const doc = state.doc;
  if (openFrom < 0 || openFrom > doc.length) {
    return null;
  }
  const openLine = doc.lineAt(openFrom);
  let body: string | null = null;
  syntaxTree(state).iterate({
    from: openLine.from,
    to: openLine.to,
    enter: (node) => {
      if (body !== null) {
        return false;
      }
      if (node.name === "FencedCode" && doc.lineAt(node.from).from === openLine.from) {
        body = fencedCodeBody(state, node.node);
        return false;
      }
      return undefined;
    },
  });
  return body;
}

/** Emit one copy button per fenced code block whose open line is in a visible
 *  range — top-level AND blockquote-/list-NESTED. Read-only surfaces get nothing
 *  (the affordance is interactive, and the read-only editor is a dimmed,
 *  hands-off surface). A nested fence's body carries a `> ` / list-indent
 *  continuation prefix, but {@link fencedCodeBody} strips it (via the parser's
 *  CodeText boundaries), so the copied payload is the code, not the structure. */
export function buildCopyButtons(ctx: BuildContext): DecorationSet {
  if (ctx.state.readOnly) {
    return Decoration.none;
  }
  const doc = ctx.state.doc;
  const seen = new Set<number>();
  const out: Array<{ from: number; deco: Decoration }> = [];
  for (const range of ctx.visibleRanges) {
    ctx.tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (node.name !== "FencedCode") {
          return;
        }
        // Anchor at the open LINE start (not node.from, which sits after any
        // indent or `> `/list prefix). The fence-reveal HIDE replace begins at
        // node.from: for an INDENTED (or nested) fence line.from < node.from so
        // the widget is strictly before the replace; for the common UNINDENTED
        // fence line.from === node.from, and a side:-1 point widget at the start
        // of a replace range still renders (it associates with the position
        // BEFORE the replaced text). The DOM-integration test pins that the
        // button survives co-located with the replace.
        const openFrom = doc.lineAt(node.from).from;
        // De-dup by open-line offset only — do NOT gate on `openFrom >= range.from`.
        // CodeMirror's visibleRanges can begin mid-line when a line-gap decoration
        // splits a long wrapped line, so a fence whose open line starts just before
        // the range would be silently dropped even though it is rendered (same
        // reason list-hang-indent removed this guard — Codex review #92). The
        // `seen` set keeps a block visited from multiple ranges to one button; the
        // final sort satisfies RangeSetBuilder's non-decreasing-`from` contract.
        if (seen.has(openFrom)) {
          return;
        }
        seen.add(openFrom);
        // Inject the click-time body resolver (a stable module-level fn) + the
        // open-line offset key rather than the materialised body: the body is
        // resolved LAZILY at click against the live state (see fencedCodeBodyAt),
        // so a per-keystroke edit inside a large block allocates no body here.
        const widget = new CopyButtonWidget(openFrom, fencedCodeBodyAt);
        out.push({ from: openFrom, deco: Decoration.widget({ widget, side: -1 }) });
      },
    });
  }
  out.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const entry of out) {
    builder.add(entry.from, entry.from, entry.deco);
  }
  return builder.finish();
}

function toCtx(view: EditorView): BuildContext {
  return {
    state: view.state,
    selection: view.state.selection,
    visibleRanges: view.visibleRanges,
    tree: syntaxTree(view.state),
  };
}

/** Selection-INDEPENDENT ViewPlugin holding the copy-button widgets. Parallel to
 *  blockquoteRule (line-only, selection-independent). Rebuild triggers: doc / viewport
 *  / parsed-tree change, plus a readOnly flip (the editableComp reconfigure that
 *  toggles read-only) so the buttons appear/disappear with write capability. An
 *  INLINE point widget is legal from a ViewPlugin — only BLOCK replaces are not.
 *  Module-level const (stable identity) so `view.plugin(fencedCodeCopyButton)`
 *  resolves in tests — mirrors blockquoteRule. */
export const fencedCodeCopyButton = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildCopyButtons(toCtx(view));
    }
    update(u: ViewUpdate): void {
      if (
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.startState.readOnly !== u.state.readOnly
      ) {
        this.decorations = buildCopyButtons(toCtx(u.view));
      }
    }
  },
  { decorations: (v) => v.decorations }
);
