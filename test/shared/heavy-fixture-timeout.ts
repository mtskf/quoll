/**
 * Per-test timeout for the tests that build a MiB-scale fixture (a 1 MiB parse, a
 * 4 MiB CodeMirror insert).
 *
 * These bodies are CPU-bound for 1–2.5 s on an idle machine, and this repo runs
 * vitest with uncapped parallel workers by design (see vitest.config.ts), so on an
 * oversubscribed dev box they were measured at 9–50 s — past vitest's 5 s default.
 * None of them asserts on wall-clock time, so the default only ever produced a
 * load-dependent red. The value is deliberately far above the measured worst case
 * and costs nothing when the test passes. It does not catch a hang: the bodies are
 * synchronous and vitest cannot pre-empt one, so the limit is only compared once the
 * body returns — what it still fails is a pathological slow-down that does finish.
 */
export const HEAVY_FIXTURE_TIMEOUT_MS = 120_000;
