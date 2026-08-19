// Pins the requestAnimationFrame call-count contract of helpers/frames.ts
// itself. That file is depended on by most suites in this directory (plus
// helpers/handoff-window.ts and its own dependents) — an unpinned
// drift in SETTLE_FRAMES or the tick loop would surface as intermittent
// flake spread across every dependent suite rather than a clean failure
// here. See helpers/frames.ts's own header comment for why frame-based
// (not wall-clock) waits are the point.
import { afterEach, describe, expect, it, vi } from "vitest";
import { frames, raf, settled } from "./helpers/frames.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("frames helper: requestAnimationFrame call-count contract", () => {
  it("raf() awaits exactly one animation frame", async () => {
    const spy = vi.spyOn(window, "requestAnimationFrame");
    await raf();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("frames(1) awaits exactly one animation frame (no reschedule)", async () => {
    const spy = vi.spyOn(window, "requestAnimationFrame");
    await frames(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("frames(n) awaits exactly n animation frames", async () => {
    const spy = vi.spyOn(window, "requestAnimationFrame");
    await frames(3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("settled() awaits exactly SETTLE_FRAMES (4) animation frames", async () => {
    const spy = vi.spyOn(window, "requestAnimationFrame");
    await settled();
    expect(spy).toHaveBeenCalledTimes(4);
  });

  // The call-count assertions above pin HOW MANY frames are requested, not that
  // the promise waits for them: an implementation that fires n rAF calls and
  // resolves synchronously keeps every count green while dependent suites stop
  // waiting for layout at all. This observes the elapsed frames instead.
  it("frames(n) resolves only after n frames have actually elapsed", async () => {
    // Registered BEFORE frames() so this callback runs first within each frame
    // (rAF callbacks fire in registration order) — and because it re-registers
    // itself ahead of the helper's own tick, it stays first in every later
    // frame too. So `elapsed` is current when the awaited promise resolves.
    let elapsed = 0;
    const count = (): void => {
      elapsed += 1;
      id = requestAnimationFrame(count);
    };
    let id = requestAnimationFrame(count);
    try {
      await frames(3);
      expect(elapsed).toBe(3);
    } finally {
      cancelAnimationFrame(id);
    }
  });
});
