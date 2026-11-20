// Inline-formatting commands: wrap/unwrap the MAIN selection in inline-mark
// source (bold/italic/code/strike) and wrap it as a Markdown link.
//
// The core is a PURE function over EditorState (computeInlineFormat /
// computeLinkWrap) so the wrap/unwrap/empty-selection semantics are unit-tested
// without a view or DOM. runFormatCommand is the thin dispatch wrapper: it
// guards read-only (a raw `changes` dispatch is NOT blocked by the readOnly
// facet — same reason as cm/lint/apply-fix.ts) and rides the normal dispatch ->
// edit-sync -> host write-lock pipeline via view.dispatch. There is no raw write
// path; normal write settlement and recovery apply to these edits too.
//
// Bold, italic and strike never read the editor's syntax tree. That tree is
// parsed under a time budget, can be incomplete on a large doc, and would
// misclassify an existing `**foo**` as un-bolded, corrupting it into
// `****foo****`. They unwrap by delimiter matching instead; the single-char `*`
// disambiguates against `**` via the char just beyond the delimiter. Code needs
// CommonMark's own pairing in its real container context (list, quote, fenced
// block), so it reads the editor's tree, and only once the tree is final through
// the end of the selection's block: before that it leaves the document as it is.
// A wrap is also parsed before it is returned, and dropped unless the selection
// came out as exactly one code span of its own text.
// A link label runs its own full gfmParser parse of the selected string only.

import { ensureSyntaxTree } from "@codemirror/language";
import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { codeSpanSource, codeSpanStripsEdges } from "../../../markdown/code-span-source.js";
import { markdownLinkSource } from "../../../markdown/link-source.js";
import type { FormatAction } from "../../../shared/protocol.js";
import { expandToEnclosingBlock } from "../structural-guard.js";

// open === close for every inline mark; a single `marker` string is enough.
// Keyed by the protocol's action set minus `link` and `code` (each has its own
// branch in computeInlineFormat), so an action added there fails `pnpm compile`
// here until it has a marker (or an explicit non-marker branch) — the webview
// cannot silently ignore one.
const MARKERS: Record<Exclude<FormatAction, "link" | "code">, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
};

type FormatSpec = { changes: ChangeSpec; selection: SelectionRange };

/** True iff `doc[pos .. pos+s.length] === s`, with bounds guard (out-of-range
 *  -> false; CM `sliceString` throws on a negative index). */
function matchAt(doc: Text, pos: number, s: string): boolean {
  return pos >= 0 && pos + s.length <= doc.length && doc.sliceString(pos, pos + s.length) === s;
}

/** True iff the single char at `pos` is NOT `ch` (out-of-range -> no such char
 *  -> true). Used so a single-char delimiter is not mistaken for part of a
 *  longer run (a `*` inside `**`). */
function charIsNot(doc: Text, pos: number, ch: string): boolean {
  return pos < 0 || pos >= doc.length || doc.sliceString(pos, pos + 1) !== ch;
}

function toggleMark(state: EditorState, marker: string): FormatSpec {
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const L = marker.length;
  const single = L === 1;

  // Empty selection -> insert the pair, caret between.
  if (from === to) {
    return {
      changes: { from, insert: marker + marker },
      selection: EditorSelection.cursor(from + L),
    };
  }

  // Case B: delimiters immediately OUTSIDE the selection (inner text selected —
  // the round-trip case). For single-char markers, the char beyond each
  // delimiter must not be the same char (else it's a `**`/double run).
  if (
    matchAt(doc, from - L, marker) &&
    matchAt(doc, to, marker) &&
    (!single || (charIsNot(doc, from - L - 1, marker) && charIsNot(doc, to + L, marker)))
  ) {
    return {
      changes: [
        { from: from - L, to: from },
        { from: to, to: to + L },
      ],
      selection: EditorSelection.range(from - L, to - L),
    };
  }

  // Case A: delimiters are the outer EDGES of the selection (whole span,
  // markers included). Needs room for both delimiters (to - from >= 2L).
  if (
    to - from >= 2 * L &&
    matchAt(doc, from, marker) &&
    matchAt(doc, to - L, marker) &&
    (!single || (charIsNot(doc, from + L, marker) && charIsNot(doc, to - L - 1, marker)))
  ) {
    return {
      changes: [
        { from, to: from + L },
        { from: to - L, to },
      ],
      selection: EditorSelection.range(from, to - 2 * L),
    };
  }

  // Wrap: insert marker at from and to; keep the inner text selected so a second
  // press round-trips.
  return {
    changes: [
      { from, insert: marker },
      { from: to, insert: marker },
    ],
    selection: EditorSelection.range(from + L, to + L),
  };
}

type CodeSpan = { from: number; to: number; body: string };
type SyntaxNode = NonNullable<ReturnType<typeof ensureSyntaxTree>>["topNode"];

/** The tree through the end of the block around `from..to`, or `null` while
 *  the parse cannot finish it within the budget. Code is judged only on a
 *  final tree. This is the tree the parse has reached, not the state's stored
 *  `syntaxTree(state)`: `ensureSyntaxTree` advances the parse without
 *  replacing the stored tree, which can stop short of the block. */
function finalTree(state: EditorState, from: number, to: number) {
  const block = expandToEnclosingBlock(state, from, to);
  const tree = ensureSyntaxTree(state, block.to, 50);
  return tree && { tree, block };
}

/** The bytes between an InlineCode node's first and last CodeMark. */
function inlineCodeBody(doc: Text, node: SyntaxNode): { open: number; close: number; raw: string } {
  const marks = node.getChildren("CodeMark");
  const open = marks[0].to;
  const close = marks[marks.length - 1].from;
  return { open, close, raw: doc.sliceString(open, close) };
}

/** What the editor's tree says about inline code around the selection: the span
 *  it is (or is the body of, as written or with the one-space strip applied),
 *  whether it cuts into code it must not split, and the lengths of backtick
 *  runs before it in its block that may be unmatched. `null` while the tree is
 *  not final through the end of that block. */
function codeContext(
  state: EditorState,
  from: number,
  to: number
): { span: CodeSpan | null; splitsCode: boolean; literalRuns: Set<number> } | null {
  const doc = state.doc;
  // A code span cannot cross a blank line, so every one the selection can meet
  // or pair with sits in this run of lines.
  const final = finalTree(state, from, to);
  if (!final) {
    return null;
  }
  let span: CodeSpan | null = null;
  let splitsCode = false;
  // The block's text before the selection with its code spans cut out: their
  // runs are already paired, every other run may still take a new opener.
  const before: string[] = [];
  let cursor = final.block.from;
  final.tree.iterate({
    from: final.block.from,
    to,
    enter(node) {
      const inline = node.name === "InlineCode";
      if (!inline && node.name !== "FencedCode" && node.name !== "CodeBlock") {
        return;
      }
      if (node.to <= from) {
        if (inline) {
          before.push(doc.sliceString(cursor, node.from), " ");
          cursor = node.to;
        }
        return false;
      }
      if (node.from >= to) {
        return false;
      }
      if (inline) {
        const { open, close, raw } = inlineCodeBody(doc, node.node);
        const strips = codeSpanStripsEdges(raw);
        if (from === node.from && to === node.to) {
          span = { from: node.from, to: node.to, body: strips ? raw.slice(1, -1) : raw };
          return false;
        }
        if ((from === open && to === close) || (strips && from === open + 1 && to === close - 1)) {
          span = { from: node.from, to: node.to, body: doc.sliceString(from, to) };
          return false;
        }
      }
      if (node.from < from || node.to > to) {
        splitsCode = true;
      }
      return false;
    },
  });
  before.push(doc.sliceString(cursor, from));
  const literalRuns = new Set<number>();
  for (const [run] of before.join("").matchAll(/`+/g)) {
    literalRuns.add(run.length);
  }
  return { span, splitsCode, literalRuns };
}

/** True iff `state` parses `from..to` as exactly one code span that renders
 *  `text`. Checked on the wrapped document, so a fence that pairs or opens
 *  anything other than that span is caught however it came about. A span with
 *  any child but its fences (a blockquote's `>` on a later line) does not render
 *  its raw slice. */
function rendersAsCode(state: EditorState, from: number, to: number, text: string): boolean {
  const final = finalTree(state, from, to);
  let renders = false;
  final?.tree.iterate({
    from,
    to,
    enter(node) {
      if (node.name === "InlineCode" && node.from === from && node.to === to) {
        const { raw } = inlineCodeBody(state.doc, node.node);
        let onlyFences = true;
        for (let c = node.node.firstChild; c; c = c.nextSibling) {
          onlyFences &&= c.name === "CodeMark";
        }
        renders = onlyFences && (codeSpanStripsEdges(raw) ? raw.slice(1, -1) : raw) === text;
      }
      return !renders;
    },
  });
  return renders;
}

/** Toggle inline code so the rendered body is the whole selection. The
 *  editor's tree finds the span the selection is (or is the body of) and
 *  unwraps it to that body; otherwise the selection is fenced past any backtick
 *  run inside and any length an earlier unmatched run could pair with, padded
 *  as CommonMark needs. The document stays as it is while the tree is not
 *  final, when a fence would split code or join a neighbouring backtick, and
 *  when the wrapped document does not parse as that one span. */
function toggleCode(state: EditorState): FormatSpec {
  const { from, to } = state.selection.main;
  const doc = state.doc;
  const unchanged: FormatSpec = { changes: [], selection: state.selection.main };

  if (from === to) {
    return {
      changes: { from, insert: "``" },
      selection: EditorSelection.cursor(from + 1),
    };
  }

  const context = codeContext(state, from, to);
  if (!context) {
    return unchanged;
  }
  const { span } = context;
  if (span) {
    return {
      changes: { from: span.from, to: span.to, insert: span.body },
      selection: EditorSelection.range(span.from, span.from + span.body.length),
    };
  }

  // Code the selection only partly covers would be split; a fence beside a
  // backtick would join that run and take in text outside the selection.
  if (context.splitsCode || matchAt(doc, from - 1, "`") || matchAt(doc, to, "`")) {
    return unchanged;
  }

  const text = doc.sliceString(from, to);
  const source = codeSpanSource(text, context.literalRuns);
  const changes: ChangeSpec = { from, to, insert: source };
  if (!rendersAsCode(state.update({ changes }).state, from, from + source.length, text)) {
    return unchanged;
  }
  const start = from + (source.length - text.length) / 2;
  return { changes, selection: EditorSelection.range(start, start + text.length) };
}

/** Wrap the main selection as `[text]()` with the caret in the destination slot.
 *  An empty selection gets `[]()` with the caret in the label slot. */
export function computeLinkWrap(state: EditorState): FormatSpec {
  const { from, to } = state.selection.main;
  if (from === to) {
    return {
      changes: { from, insert: "[]()" },
      selection: EditorSelection.cursor(from + 1),
    };
  }
  const source = markdownLinkSource(state.doc.sliceString(from, to), "");
  return {
    changes: { from, to, insert: source },
    selection: EditorSelection.cursor(from + source.length - 1),
  };
}

export function computeInlineFormat(state: EditorState, action: FormatAction): FormatSpec {
  if (action === "link") {
    return computeLinkWrap(state);
  }
  if (action === "code") {
    return toggleCode(state);
  }
  return toggleMark(state, MARKERS[action]);
}

/** Dispatch wrapper. Guards read-only; the edit rides the normal dispatch ->
 *  edit-sync -> host write-lock pipeline. Returns true on dispatch. */
export function runFormatCommand(view: EditorView, action: FormatAction): boolean {
  // Only act when the editor content owns focus. The host keybindings are scoped
  // to `activeCustomEditorId`, which is true whenever the Quoll panel is active —
  // including when focus sits in another webview control (e.g. the CodeMirror
  // search/replace panel). Without this guard, Cmd+B pressed there would format
  // the editor's last selection instead of no-op'ing. `hasFocus` is true only
  // while `.cm-content` holds focus.
  if (!view.hasFocus) {
    return false;
  }
  if (view.state.readOnly) {
    return false;
  }
  const spec = computeInlineFormat(view.state, action);
  view.dispatch({ ...spec, userEvent: `quoll.format.${action}` });
  return true;
}
