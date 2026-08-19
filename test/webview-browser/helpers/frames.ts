// Frame-waiting primitives shared across the test/webview-browser/ suites.
// These live here rather than in each suite because a per-suite copy can
// silently drift on frame count — and a suite waiting one frame too few goes
// flaky under CI load while its siblings stay green, which is exactly the
// failure that is hardest to attribute. Not a test file itself (no
// .browser.test.ts suffix), mirroring helpers/handoff-window.ts.
//
// Frame-based (not wall-clock) waits are the point: they scale with actual
// frame progress under headless/CI rAF throttling, and CodeMirror's own measure
// scheduling is frame-based, so the test vehicle must be too.

/** Await a single animation frame. */
export function raf(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Await n animation frames. */
export function frames(n: number): Promise<void> {
  return new Promise((resolve) => {
    let left = n;
    const tick = (): void => {
      if (--left <= 0) {
        resolve();
      } else {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
}

/** Frames awaited by settled(). CM's measure queue is BOUNDED: e.g.
 *  proseSpaceMetric writes --quoll-prose-space on its first measure, then
 *  queues (via queueMicrotask) exactly ONE follow-up view.requestMeasure to
 *  rebuild the height map against the new padding, and that re-measure
 *  CONVERGES (prose-space-metric.ts). Because the settling is bounded, a small
 *  fixed frame count drains every pending measure regardless of microtask/rAF
 *  interleaving — more robust than a 2-frame wait whose ordering vs the
 *  microtask-scheduled re-measure is not guaranteed (Codex C84). */
const SETTLE_FRAMES = 4;

/** Drain CM's bounded measure queue so getBoundingClientRect /
 *  getComputedStyle / coordsAtPos read a settled layout and height map
 *  (Codex C93). */
export function settled(): Promise<void> {
  return frames(SETTLE_FRAMES);
}
