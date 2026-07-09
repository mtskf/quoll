// Pure screen→document height math for the sticky-heading bar. Layout-free so it
// is unit-tested; the ViewPlugin supplies the CM geometry values and feeds the
// result to view.lineBlockAtHeight. See the plan's "Geometry & parse notes".

/** Geometry inputs for {@link stickyTopHeight}, all in CM's SCREEN-pixel space
 *  (`getBoundingClientRect` / `EditorView.documentTop` / `EditorView.contentHeight`
 *  are all screen-space in CM 6 — the block height map stores transformed pixels).
 *  A named object rather than positional args because every field is a same-typed
 *  screen-Y number, so a positional swap would silently mis-place the boundary. */
export interface StickyTopHeightInput {
  /** Screen-Y of the scroller's top edge (`scrollDOM.getBoundingClientRect().top`). */
  scrollerTop: number;
  /** Screen-Y of the document's top (`EditorView.documentTop`). */
  documentTop: number;
  /** The sticky bar's own height, or 0 while hidden — the boundary is the bar's
   *  BOTTOM edge so the bar never occludes the heading it is about to show. */
  barHeight: number;
  /** Document content height (`EditorView.contentHeight`), screen-space. */
  contentHeight: number;
}

/** Document-space height at the STICKY BAR'S BOTTOM edge. CM's `lineBlockAtHeight`
 *  takes a height relative to `documentTop`, in the SAME screen-pixel space as the
 *  block height map — so the height at a screen-Y is simply `screenY - documentTop`,
 *  with NO `/scaleY`: the height map already stores transformed (post-CSS-scale)
 *  pixels, and CM's own posAtCoords / gutter paths pass the undivided delta
 *  (verified against @codemirror/view 6.43 — documentTop folds in `paddingTop *
 *  scaleY`, and contentHeight is divided by scaleY only when converting to layout
 *  px). Here `screenY = scrollerTop + barHeight`. Clamped to `[0, contentHeight]`
 *  so `lineBlockAtHeight` never receives an out-of-range value. */
export function stickyTopHeight(input: StickyTopHeightInput): number {
  const { scrollerTop, documentTop, barHeight, contentHeight } = input;
  const height = scrollerTop + barHeight - documentTop;
  return Math.max(0, Math.min(height, contentHeight));
}
