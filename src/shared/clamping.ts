// Shared integer clamp used by the caret-handoff translation on BOTH sides of
// the wire (host caret-handoff / handle-context-handoff, webview cm/caret). The
// copies were byte-identical; this is the single definition so they cannot drift.
// Pure + dependency-free so it crosses the host/webview bundle boundary from
// src/shared/ (no vscode, no DOM).

/** Clamp `value` into the inclusive `[min, max]` range after truncating toward
 *  zero. A non-finite `value` (NaN / ±Infinity) collapses to `min`. */
export function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.trunc(value), min), max);
}
