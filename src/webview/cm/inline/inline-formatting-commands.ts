// Inline-formatting commands: wrap/unwrap the MAIN selection in inline-mark
// source (bold/italic/code/strike) and wrap it as a Markdown link.
//
// The core is a PURE function over EditorState (computeInlineFormat /
// computeLinkWrap) so the wrap/unwrap/empty-selection semantics are unit-tested
// without a view or DOM. runFormatCommand is the thin dispatch wrapper: it
// guards read-only (a raw `changes` dispatch is NOT blocked by the readOnly
// facet — same reason as cm/lint/apply-fix.ts) and rides the normal dispatch ->
// edit-sync -> host write-lock pipeline via view.dispatch. There is no raw write
// path; a gate-rejecting result surfaces edit-rejected like any other edit.
//
// Unwrap detection is PURE STRING / DELIMITER MATCHING — no Markdown parser.
// A parser under a time budget can return an incomplete tree on a large doc and
// misclassify an existing `**foo**` as un-bolded, corrupting it into
// `****foo****`; string matching is deterministic and parse-free so the
// round-trip contract holds on any doc size. Single-char markers (`*`, `` ` ``)
// disambiguate against `**`/double runs via the char just beyond the delimiter.

import {
  type ChangeSpec,
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type Text,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type FormatAction = "bold" | "italic" | "code" | "strike" | "link";
export const FORMAT_ACTIONS: readonly FormatAction[] = ["bold", "italic", "code", "strike", "link"];

// open === close for every inline mark; a single `marker` string is enough.
const MARKERS: Record<Exclude<FormatAction, "link">, string> = {
  bold: "**",
  italic: "*",
  code: "`",
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

/** Wrap the main selection as `[text](url)` (or `[](url)` when empty). Always
 *  wraps — no unwrap. `url` defaults to "" with the caret placed in the url
 *  slot; a non-empty `url` (paste-URL reuse) is inserted verbatim. */
export function computeLinkWrap(state: EditorState, url = ""): FormatSpec {
  const { from, to } = state.selection.main;
  if (from === to) {
    // "[](url)" — caret in the [] text slot.
    return {
      changes: { from, insert: `[](${url})` },
      selection: EditorSelection.cursor(from + 1),
    };
  }
  // "[text](url)" — caret in the () url slot (after "](" ).
  const urlSlot = to + 1 + 2; // +1 for inserted "[", +2 for "]("
  return {
    changes: [
      { from, insert: "[" },
      { from: to, insert: `](${url})` },
    ],
    selection: EditorSelection.cursor(urlSlot + url.length),
  };
}

export function computeInlineFormat(state: EditorState, action: FormatAction): FormatSpec {
  if (action === "link") {
    return computeLinkWrap(state);
  }
  return toggleMark(state, MARKERS[action]);
}

/** Dispatch wrapper. Guards read-only; the edit rides the normal dispatch ->
 *  edit-sync -> host write-lock pipeline. Returns true on dispatch. */
export function runFormatCommand(view: EditorView, action: FormatAction): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const spec = computeInlineFormat(view.state, action);
  view.dispatch({ ...spec, userEvent: `quoll.format.${action}` });
  return true;
}
