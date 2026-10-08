// Primitives shared by every line-collapse client (fenced code, blockquote): the threshold and
// the selection-parking helper. Moved verbatim out of fenced-code-collapse-state.ts, which
// re-exports both so no importer changes.

import { EditorSelection } from "@codemirror/state";

/** Bodies with strictly MORE than this many lines collapse; 10 or fewer render
 *  unchanged. */
export const COLLAPSE_THRESHOLD = 10;

/** Move EVERY selection range whose head lands in `[concealFrom, concealTo]` out to
 *  a cursor at `safeCaret`; ranges whose head is outside are kept verbatim. Returns
 *  `null` when no head is inside (no selection change needed).
 *
 *  DD4 symmetry: the build's auto-expand checks ALL range heads, so parking only
 *  `selection.main.head` would let a SECONDARY caret inside the region re-trigger
 *  auto-expand on the very next rebuild → an infinite collapse↔expand loop. Parking
 *  every inside-head closes that loop.
 *
 *  Two inside-heads parked onto the SAME `safeCaret` merge inside
 *  `EditorSelection.create` → `normalized`, which adjusts `mainIndex` with
 *  `if (i <= mainIndex) mainIndex--` on every merge at/before the main (verified
 *  against @codemirror/state 6.6.0 `EditorSelection.normalized` — the merge
 *  decrements `mainIndex` for ANY merge index `<= mainIndex`, not only `===`), so
 *  the result stays in range even when an outside main sits at a higher index than
 *  two merged inside cursors. NO out-of-bounds. Pinned by the 3-cursor test. */
export function parkSelectionOutsideConceal(
  selection: EditorSelection,
  concealFrom: number,
  concealTo: number,
  safeCaret: number
): EditorSelection | null {
  let changed = false;
  const ranges = selection.ranges.map((r) => {
    if (r.head >= concealFrom && r.head <= concealTo) {
      changed = true;
      return EditorSelection.cursor(safeCaret);
    }
    return r;
  });
  return changed ? EditorSelection.create(ranges, selection.mainIndex) : null;
}
