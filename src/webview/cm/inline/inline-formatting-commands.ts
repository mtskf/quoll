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
// Unwrap detection is PURE STRING / DELIMITER MATCHING — no Markdown parser.
// A parser under a time budget can return an incomplete tree on a large doc and
// misclassify an existing `**foo**` as un-bolded, corrupting it into
// `****foo****`; string matching is deterministic and parse-free so the
// round-trip contract holds on any doc size. The single-char `*` disambiguates
// against `**` via the char just beyond the delimiter. Code is its own toggle:
// its fence grows past any backtick run in the selection (code-span-source.ts),
// so it matches whole backtick runs of equal length instead of one marker.
// Link label escaping parses only the selected string in a full, deterministic parse.

import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  codeSpanSource,
  codeSpanStripsEdges,
  hasBacktickRunOf,
} from "../../../markdown/code-span-source.js";
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

/** Length of the backtick run ending at `pos` (`dir` -1) or starting there (`dir` 1). */
function backtickRun(doc: Text, pos: number, dir: -1 | 1): number {
  let n = 0;
  for (let p = dir < 0 ? pos - 1 : pos; p >= 0 && p < doc.length; p += dir) {
    if (doc.sliceString(p, p + 1) !== "`") {
      break;
    }
    n++;
  }
  return n;
}

/** Toggle inline code so the rendered body is the whole selection: a wrap
 *  fences it past any backtick run inside, padded as CommonMark needs, and an
 *  unwrap removes a fence pair of equal length (plus its padding space) that
 *  no run inside could have closed first. */
function toggleCode(state: EditorState): FormatSpec {
  const { from, to } = state.selection.main;
  const doc = state.doc;

  if (from === to) {
    return {
      changes: { from, insert: "``" },
      selection: EditorSelection.cursor(from + 1),
    };
  }

  // Inner text selected: the fences sit just outside it, after a padding space
  // on each side when the body as written strips one.
  for (const pad of [1, 0]) {
    const open = from - pad;
    const close = to + pad;
    if (open < 0 || close > doc.length) {
      continue;
    }
    const body = doc.sliceString(open, close);
    if (pad === 1 && !codeSpanStripsEdges(body)) {
      continue;
    }
    const fence = backtickRun(doc, open, -1);
    if (fence > 0 && backtickRun(doc, close, 1) === fence && !hasBacktickRunOf(body, fence)) {
      return {
        changes: [
          { from: open - fence, to: from },
          { from: to, to: close + fence },
        ],
        selection: EditorSelection.range(open - fence, open - fence + (to - from)),
      };
    }
  }

  // Whole span selected, fences included.
  const text = doc.sliceString(from, to);
  const fence = text.length - text.replace(/^`+/, "").length;
  const closingFence = text.length - text.replace(/`+$/, "").length;
  if (fence > 0 && fence < text.length && closingFence === fence) {
    const body = text.slice(fence, -fence);
    if (!hasBacktickRunOf(body, fence)) {
      const edge = fence + (codeSpanStripsEdges(body) ? 1 : 0);
      return {
        changes: [
          { from, to: from + edge },
          { from: to - edge, to },
        ],
        selection: EditorSelection.range(from, to - 2 * edge),
      };
    }
  }

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
