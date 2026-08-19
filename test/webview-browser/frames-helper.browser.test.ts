// Pins the requestAnimationFrame call-count contract of helpers/frames.ts
// itself. That file is depended on by every other suite in this directory
// (plus helpers/handoff-window.ts and its own dependents) — an unpinned
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
});
