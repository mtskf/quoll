// Lightweight, development-only performance instrumentation.
//
// A zero-dependency aggregator consumed by BOTH bundles (host CJS + webview
// ESM), mirroring src/shared/protocol.ts's cross-bundle pattern. It imports
// nothing — only the `performance` + `console` globals (present in Node 20 and
// the webview browser sandbox) — so neither bundle gains a dependency.
//
// The build flag `QUOLL_PERF` is a bare global (declared in
// src/shared/quoll-perf-flag.d.ts, injected by esbuild/vitest `define`). Every
// perf call site — including perfReport's log below — guards with a bare
// `if (QUOLL_PERF)`, which esbuild folds + dead-codes in production. perfRecord
// stays ungated so the unit suite exercises the aggregation regardless of the
// flag (vitest defines QUOLL_PERF=false).

/** Per-stage rolled-up timing, all in milliseconds. */
export type StageSummary = {
  count: number;
  total: number;
  avg: number;
  min: number;
  max: number;
};

export type PerfSummary = Record<string, StageSummary>;

type Accumulator = { count: number; total: number; min: number; max: number };

const stats = new Map<string, Accumulator>();

/** Monotonic clock in ms. `performance` exists in Node 20 and the webview
 *  browser sandbox; the fallback keeps perfNow total (defined for every host)
 *  — if one lacks `performance`, timings read 0 rather than throwing. Callers
 *  on security-critical paths rely on this never throwing. */
export function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

/** Round to 3 decimals so the logged summary stays readable. */
function round(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

/** Record one duration (ms) under `stage`. Aggregates only — NEVER logs per
 *  call (the "aggregate only" contract). Ungated so the unit suite exercises
 *  it regardless of the build flag. Pure Map arithmetic: never throws. */
export function perfRecord(stage: string, ms: number): void {
  const acc = stats.get(stage);
  if (acc === undefined) {
    stats.set(stage, { count: 1, total: ms, min: ms, max: ms });
    return;
  }
  acc.count += 1;
  acc.total += ms;
  if (ms < acc.min) {
    acc.min = ms;
  }
  if (ms > acc.max) {
    acc.max = ms;
  }
}

/** Snapshot the cumulative aggregate as a plain object (null when empty) and
 *  log one line. The log is gated by the bare `QUOLL_PERF` so the unit suite
 *  (flag off) stays quiet while dev builds still print; the returned object is
 *  what the tests assert. Callers ALSO guard the call with `if (QUOLL_PERF)`
 *  so production dead-codes it entirely. */
export function perfReport(label: string): PerfSummary | null {
  if (stats.size === 0) {
    return null;
  }
  const summary: PerfSummary = {};
  for (const [stage, acc] of stats) {
    summary[stage] = {
      count: acc.count,
      total: round(acc.total),
      avg: round(acc.total / acc.count),
      min: round(acc.min),
      max: round(acc.max),
    };
  }
  if (QUOLL_PERF) {
    console.log(`[quoll][perf] ${label}`, summary);
  }
  return summary;
}

/** Clear all accumulators (test isolation; unused in production). */
export function perfReset(): void {
  stats.clear();
}
