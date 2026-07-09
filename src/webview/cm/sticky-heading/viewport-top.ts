// Pure screen→document height math for the sticky-heading bar. Layout-free so it
// is unit-tested; the ViewPlugin supplies the CM geometry values and feeds the
// result to view.lineBlockAtHeight. See the plan's "Geometry & parse notes".

/** Document-space height at the STICKY BAR'S BOTTOM edge (so the bar never
 *  occludes the heading it is about to show). CM's `lineBlockAtHeight` takes a
 *  height relative to `documentTop` (screen coords); a point at document height
 *  `H` renders at screen-Y `documentTop + H*scaleY`, so `H = (screenY - documentTop)
 *  / scaleY`. Here `screenY = scrollerTop + barHeight`. Clamped to `[0,
 *  contentHeight]` so `lineBlockAtHeight` never receives an out-of-range value. */
export function stickyTopHeight(
  scrollerTop: number,
  documentTop: number,
  barHeight: number,
  scaleY: number,
  contentHeight: number
): number {
  const height = (scrollerTop + barHeight - documentTop) / scaleY;
  return Math.max(0, Math.min(height, contentHeight));
}
