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
// Nothing here reads the editor's syntax tree. That tree is parsed under a time
// budget, can be incomplete on a large doc, and would misclassify an existing
// `**foo**` as un-bolded, corrupting it into `****foo****`. Bold, italic and
// strike unwrap by delimiter matching instead; the single-char `*`
// disambiguates against `**` via the char just beyond the delimiter. Code and
// link labels need CommonMark's own pairing, so each runs its own full,
// deterministic gfmParser parse of a bounded string: code parses the
// selection's paragraph to find the span it unwraps, and a link label parses
// only the selected string.

import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { codeSpanSource, codeSpanStripsEdges } from "../../../markdown/code-span-source.js";
import { gfmParser } from "../../../markdown/gfm-parser.js";
import { markdownLinkSource } from "../../../markdown/link-source.js";
import type { FormatAction } from "../../../shared/protocol.js";

// open === close for every inline mark; a single `marker` string is enough.
// Keyed by the protocol's action set minus `link`, so an action added there
// fails `pnpm compile` here until it has a marker (or an explicit non-marker
// branch in computeInlineFormat) — the webview cannot silently ignore one.
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

const isBlankLine = (text: string) => /^[ \t]*$/.test(text);

/** The selected lines widened to the nearest blank line on each side: a code
 *  span cannot cross a blank line, so this holds every span the selection
 *  could touch, with its list or quote markers for the parser to read. */
function paragraphAround(doc: Text, from: number, to: number): { start: number; text: string } {
  let first = doc.lineAt(from);
  while (first.number > 1 && !isBlankLine(doc.line(first.number - 1).text)) {
    first = doc.line(first.number - 1);
  }
  let last = doc.lineAt(to);
  while (last.number < doc.lines && !isBlankLine(doc.line(last.number + 1).text)) {
    last = doc.line(last.number + 1);
  }
  return { start: first.from, text: doc.sliceString(first.from, last.to) };
}

/** The code span the selection is, or is the body of — as written or with the
 *  one-space strip applied — and the text it renders as. */
function selectedCodeSpan(
  doc: Text,
  from: number,
  to: number
): { from: number; to: number; body: string } | null {
  const { start, text } = paragraphAround(doc, from, to);
  let span: { from: number; to: number; body: string } | null = null;
  gfmParser.parse(text).iterate({
    enter(node) {
      if (span || node.name !== "InlineCode") {
        return;
      }
      const marks = node.node.getChildren("CodeMark");
      const open = start + marks[0].to;
      const close = start + marks[marks.length - 1].from;
      const raw = doc.sliceString(open, close);
      const strips = codeSpanStripsEdges(raw);
      const spanFrom = start + node.from;
      const spanTo = start + node.to;
      if (from === spanFrom && to === spanTo) {
        span = { from: spanFrom, to: spanTo, body: strips ? raw.slice(1, -1) : raw };
      } else if (
        (from === open && to === close) ||
        (strips && from === open + 1 && to === close - 1)
      ) {
        span = { from: spanFrom, to: spanTo, body: doc.sliceString(from, to) };
      }
      return false;
    },
  });
  return span;
}

/** Toggle inline code so the rendered body is the whole selection. A full parse
 *  of the paragraph finds the span the selection is (or is the body of) and
 *  unwraps it to that body; otherwise the selection is fenced past any backtick
 *  run inside, padded as CommonMark needs. */
function toggleCode(state: EditorState): FormatSpec {
  const { from, to } = state.selection.main;
  const doc = state.doc;

  if (from === to) {
    return {
      changes: { from, insert: "``" },
      selection: EditorSelection.cursor(from + 1),
    };
  }

  const span = selectedCodeSpan(doc, from, to);
  if (span) {
    return {
      changes: { from: span.from, to: span.to, insert: span.body },
      selection: EditorSelection.range(span.from, span.from + span.body.length),
    };
  }

  // A fence beside a backtick would join that run and take in text outside the
  // selection, so leave the document as it is.
  if (matchAt(doc, from - 1, "`") || matchAt(doc, to, "`")) {
    return { changes: [], selection: state.selection.main };
  }

  const text = doc.sliceString(from, to);
  const source = codeSpanSource(text);
  const start = from + (source.length - text.length) / 2;
  return {
    changes: { from, to, insert: source },
    selection: EditorSelection.range(start, start + text.length),
  };
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
