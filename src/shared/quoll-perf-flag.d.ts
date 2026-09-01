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
// Every tsc program that compiles a `QUOLL_PERF` reference includes
// `src/shared/**`, so this one file reaches all of them with no tsconfig
// `include` edits. Not every program in the repo does: the E2E emit config
// (`test/extension/tsconfig.json`, `rootDir: "."`) pulls in no `src/` file at
// all — it deliberately mirrors the wire constants rather than importing them,
// and it references no QUOLL_PERF. Before widening this claim, enumerate with
// `git ls-files '*tsconfig*.json'`; reading the `compile` script instead misses
// the configs no script chains.
declare const QUOLL_PERF: boolean;
