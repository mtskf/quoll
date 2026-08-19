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
  // waiting for layout at all. These observe the elapsed frames instead — one
  // per entry point, because raf() carries its own wait loop and settled() only
  // reaches frames() by delegation, so pinning frames() alone leaves the other
  // two free to resolve early.
  const waits: [name: string, wait: () => Promise<void>, expected: number][] = [
    ["raf()", raf, 1],
    ["frames(n)", () => frames(3), 3],
    ["settled()", settled, 4],
  ];

  for (const [name, wait, expected] of waits) {
    it(`${name} resolves only after ${expected} frame(s) have actually elapsed`, async () => {
      // Registered BEFORE the wait so this callback runs first within each frame
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
        await wait();
        expect(elapsed).toBe(expected);
      } finally {
        cancelAnimationFrame(id);
      }
    });
  }
});
