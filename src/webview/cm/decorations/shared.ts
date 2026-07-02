// Shared primitives reused by every inline reveal provider
// (heading-reveal, blockquote-reveal, inline-mark-reveal).
//
// Centralising these here means:
//   - The `.quoll-syntax-reveal` class name has a single source of truth —
//     styles.css and every provider read the same const, so a rename cannot
//     desync the CSS contract.
//   - `intersectsAnySelection` and the trailing-whitespace absorber are
//     identical across providers; previous review-cycle iterations
//     accidentally diverged the bodies (e.g. single-space absorbed in two
//     places but not the third), which is the exact class of regression
//     `shared.ts` exists to prevent.
//   - Inline-mark provider abuts content directly (no structural whitespace
//     between mark and content) and therefore does NOT call
//     `absorbStructuralWhitespace`; it still reuses `REVEAL_MARK` / `HIDE` /
//     `intersectsAnySelection`.

import { Decoration } from "@codemirror/view";

import type { BuildContext } from "./types.js";

/** CSS class applied to REVEAL (dim) decorations. The styles.css
 *  `.quoll-syntax-reveal` rule is the consumer; renaming requires
 *  updating both this const and the CSS in lockstep. */
export const REVEAL_CLASS = "quoll-syntax-reveal";

/** Shared `Decoration.mark` instance used by every provider for the REVEAL
 *  (dim) state. Decoration specs are interned by CodeMirror — sharing one
 *  instance also lets the RangeSet implementation dedupe across providers. */
export const REVEAL_MARK = Decoration.mark({ class: REVEAL_CLASS });

/** Shared `Decoration.replace({})` instance used by every provider for the
 *  HIDE state. Empty spec is intentional: the bytes are replaced with the
 *  empty DOM, not substituted with widget content. */
export const HIDE = Decoration.replace({});

/** Returns `true` if any selection range intersects the closed interval
 *  `[from, to]`. Inclusive on both ends so a zero-width caret sitting at a
 *  boundary counts as inside — matches the heading/blockquote/inline-mark
 *  reveal contract that "caret at the closing `**` boundary reveals". */
export function intersectsAnySelection(
  selection: BuildContext["selection"],
  from: number,
  to: number
): boolean {
  for (const r of selection.ranges) {
    if (r.from <= to && r.to >= from) {
      return true;
    }
  }
  return false;
}

/** Extend a HIDE range past ALL consecutive space (`' '`) and tab (`'\t'`)
 *  characters that follow `from`, capped at the end of the line containing
 *  `from`. Used by heading- and blockquote-reveal so the rendered output
 *  doesn't carry a phantom indent after the syntax mark is hidden.
 *
 *  Previously this absorbed only ONE space character — but CommonMark
 *  allows multiple structural spaces (`#  Heading`) and the blockquote
 *  marker is permitted to be tab-separated (`>\tquote`). Obsidian Live
 *  Preview consumes ALL structural whitespace between the mark and the
 *  content; we match that contract.
 *
 *  Capping at the line end prevents overshooting into a subsequent line
 *  in pathological inputs like `>\n` (mark followed by EOL); we stop at
 *  the line boundary even if the next line happens to start with spaces. */
export function absorbStructuralWhitespace(state: BuildContext["state"], from: number): number {
  const docLength = state.doc.length;
  if (from >= docLength) {
    return from;
  }
  const lineEnd = state.doc.lineAt(from).to;
  let cursor = from;
  while (cursor < lineEnd) {
    const ch = state.doc.sliceString(cursor, cursor + 1);
    if (ch !== " " && ch !== "\t") {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

/** Returns `true` if `pos` falls inside any zone under POINT-ANCHOR
 *  containment: `[from, to)` — inclusive of the zone start, exclusive of the
 *  zone end. For LINE decorations (zero-width ranges anchored at `line.from`):
 *  a frontmatter span `[0, to]` (where `to` is the closer line's content end)
 *  contains every frontmatter line's `line.from` (`0 <= line.from < to`) and
 *  excludes the first body line below it (`line.from === to + 1 > to`).
 *  Deliberately distinct from `arbitrate`'s half-open INTERVAL overlap, which
 *  is for non-zero-width inline marks. Pass a single position (the decoration's
 *  anchor), not a range. */
export function pointInExclusionZone(
  pos: number,
  zones: readonly { from: number; to: number }[]
): boolean {
  for (const z of zones) {
    if (pos >= z.from && pos < z.to) {
      return true;
    }
  }
  return false;
}
