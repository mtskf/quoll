import { afterEach, describe, expect, it, vi } from "vitest";

import { perfNow, perfRecord, perfReport, perfReset } from "../../src/shared/perf.js";

afterEach(() => perfReset());

describe("perf aggregator", () => {
  it("returns null before any sample", () => {
    expect(perfReport("empty")).toBeNull();
  });

  it("aggregates count/total/avg/min/max across samples for one stage", () => {
    // Order is deliberately non-monotonic (first sample is neither the min nor
    // the max) so both the min AND the max update branches are pinned — an
    // ascending sequence would leave the min branch vacuously covered.
    perfRecord("load", 20);
    perfRecord("load", 10);
    perfRecord("load", 30);
    const summary = perfReport("session");
    expect(summary).not.toBeNull();
    expect(summary?.load).toEqual({ count: 3, total: 60, avg: 20, min: 10, max: 30 });
  });

  it("keeps stages independent and ordered by first insertion", () => {
    perfRecord("a", 5);
    perfRecord("b", 100);
    const summary = perfReport("session");
    expect(summary?.a.count).toBe(1);
    expect(summary?.b.max).toBe(100);
    expect(Object.keys(summary ?? {})).toEqual(["a", "b"]);
  });

  it("rounds to 3 decimals", () => {
    perfRecord("p", 1 / 3);
    const summary = perfReport("session");
    expect(summary?.p.avg).toBe(0.333);
  });

  it("does not log when the build flag is off (vitest defines QUOLL_PERF=false)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    perfRecord("x", 1);
    perfReport("session");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("perfReset clears all accumulators", () => {
    perfRecord("x", 1);
    perfReset();
    expect(perfReport("after-reset")).toBeNull();
  });

  it("perfNow returns a non-negative number", () => {
    expect(perfNow()).toBeGreaterThanOrEqual(0);
  });
});
