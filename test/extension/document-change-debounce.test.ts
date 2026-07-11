import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTrailingDebounce } from "../../src/extension/session/document-change-debounce.js";

describe("createTrailingDebounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into one trailing fire that reads the LIVE value (latest-wins)", () => {
    // The fire thunk reads a mutable holder — the faithful analog of the
    // panel thunk reading `document.version` live at fire time.
    let liveVersion = 1;
    const fires: number[] = [];
    const debounce = createTrailingDebounce(100, () => {
      fires.push(liveVersion);
    });

    liveVersion = 2;
    debounce.schedule();
    vi.advanceTimersByTime(40);
    liveVersion = 3;
    debounce.schedule(); // re-arms; earlier timer must not fire
    vi.advanceTimersByTime(40);
    liveVersion = 4;
    debounce.schedule(); // re-arms again
    expect(fires).toEqual([]); // nothing fired mid-burst

    vi.advanceTimersByTime(100);
    expect(fires).toEqual([4]); // exactly one fire, reading the latest live value
  });

  it("does not fire after cancel (cancel-on-dispose)", () => {
    const fires: number[] = [];
    const debounce = createTrailingDebounce(100, () => {
      fires.push(1);
    });

    debounce.schedule();
    vi.advanceTimersByTime(40);
    debounce.cancel();
    vi.advanceTimersByTime(1000);
    expect(fires).toEqual([]);
  });

  it("re-arms cleanly for a later, separate burst", () => {
    const fires: number[] = [];
    const debounce = createTrailingDebounce(100, () => {
      fires.push(fires.length + 1);
    });

    debounce.schedule();
    vi.advanceTimersByTime(100);
    expect(fires).toEqual([1]);

    debounce.schedule();
    vi.advanceTimersByTime(100);
    expect(fires).toEqual([1, 2]);
  });

  it("cancel is idempotent and safe with no pending timer", () => {
    const fires: number[] = [];
    const debounce = createTrailingDebounce(100, () => {
      fires.push(1);
    });
    expect(() => {
      debounce.cancel();
      debounce.cancel();
    }).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(fires).toEqual([]);
  });
});
