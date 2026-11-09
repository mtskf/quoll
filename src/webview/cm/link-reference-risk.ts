import type { EditorState } from "@codemirror/state";

/** Lezer's LinkReference leaf starts with `[`, but its length-limited nonempty label,
 *  destination and optional quoted/parenthesized title can reach later lines. The colon
 *  must immediately follow `]`; whitespace may put the destination or title on a
 *  following line. The destination/title must have a whitespace-only suffix to EOL. URLs themselves cannot span lines (angle URLs reject
 *  newlines; bare URLs stop at whitespace), while labels and titles can.
 *
 *  A changed continuation line need not contain `[`. Look back through the nonblank
 *  run on BOTH sides of the edit instead: a leaf cannot cross an ASCII blank line.
 *  Before a leaf starts, Lezer only skips whitespace and list/blockquote prefixes.
 *  Accept ANY sequence of those marker characters before `[`, rather than mirroring
 *  their nesting, spacing and digit limits. This covers container-relative starts
 *  and over-triggers on malformed prefixes, ordinary line-start links/code, and later
 *  prose in the same run. Inline images (`![…]`) remain on the bounded hot path.
 *  Newline/blank/indent changes are handled by the callers' other arms; this check
 *  also covers shapeless continuation edits. */
export function linkReferenceRisk(state: EditorState, pos: number): boolean {
  for (let n = state.doc.lineAt(pos).number; n > 0; n--) {
    const text = state.doc.line(n).text;
    if (/^[ \t]*$/.test(text)) {
      break;
    }
    if (/^[ \t>*+\d.)-]*\[/.test(text)) {
      return true;
    }
  }
  return false;
}
