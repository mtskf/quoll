// Build-time flag for the dev-only perf instrumentation (src/shared/perf.ts).
//
// Injected as a BARE literal by esbuild `define` (esbuild.config.mjs): `true`
// in dev builds (`pnpm watch`), `false` in production builds (`pnpm build`
// runs esbuild `--production`, hence every packaged .vsix). vitest defines it
// `false` (vitest.config.ts) so the unit suite runs without a ReferenceError.
//
// Declared ONCE, globally (this ambient), so every instrumented module guards
// with a bare `if (QUOLL_PERF)` — the canonical pattern esbuild constant-folds
// and dead-codes per-module in production. EMPIRICALLY VERIFIED (esbuild
// 0.25.12): bare `if (QUOLL_PERF)` + `--define:QUOLL_PERF=false --minify`
// removes the guarded body AND tree-shakes the perf module; an intermediate
// `const PERF_ENABLED = … ; if (PERF_ENABLED)` does NOT (esbuild keeps
// `const o=!1; o&&fn()`). Do NOT reintroduce an intermediate const.
//
// All four tsc programs include `src/shared/**`, so this one file is visible
// everywhere with no tsconfig `include` edits.
declare const QUOLL_PERF: boolean;
