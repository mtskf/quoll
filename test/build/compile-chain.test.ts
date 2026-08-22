// Pins the tsc project chain behind `pnpm compile`.
//
// Every type-level guarantee in this repo holds only because `compile` runs
// tsc over the project that owns it — the `@ts-expect-error` pins in
// test/build, the branded-offset assertions in test/webview, the protocol
// drift guard in test/extension. Neither vitest (esbuild transpile-only) nor
// `pnpm build`'s bundling step type-checks anything on its own, so a project
// dropped from this chain by a reformat, a bad merge or a "tidy the scripts"
// pass leaves `pnpm build`, `pnpm test` and CI ALL GREEN while every assertion
// that project gated goes permanently vacuous. That silent revert is the exact
// failure mode test/build/tsconfig.json was added to close, and this test is
// its tripwire. Pinning all five projects rather than just test/build's is
// deliberate: the accident is not specific to this directory.
//
// The roster is written down, not derived from disk, because membership is a
// judgement call: `git ls-files '*tsconfig*.json'` lists EIGHT configs and
// three of them belong outside this chain on purpose — tsconfig.base.json is
// extends-only, src/webview/tsconfig.json runs as the separate
// `compile:webview` script, and test/extension/tsconfig.json is the E2E emit
// program driven by `pnpm test:e2e:run`. A derived list would quietly adopt
// whatever config lands next instead of forcing that call to be reviewed.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
);

// Spelled exactly as the `-p` arguments appear in the script. Order matches the
// script for a simple exact compare; it is not load-bearing, so reorder both
// sides freely if the script's order ever changes for a real reason.
const CHAINED_PROJECTS = [
  "./",
  "./test/extension/tsconfig.unit.json",
  "./test/webview/tsconfig.json",
  "./test/webview-browser/tsconfig.json",
  "./test/build/tsconfig.json",
];

describe("pnpm compile project chain", () => {
  it("type-checks exactly the five reviewed projects", () => {
    const compileScript: string = pkg.scripts.compile;
    // Extracting the `-p` arguments (rather than substring-matching each
    // project) keeps the root `./` pin honest: a bare `toContain("tsc -p ./")`
    // is satisfied by any of the four nested projects and would never go red.
    const chained = [...compileScript.matchAll(/tsc -p (\S+)/g)].map((m) => m[1]);
    expect(chained).toEqual(CHAINED_PROJECTS);
  });

  // The scoped claim in src/shared/quoll-perf-flag.d.ts names this program as
  // THE exception: the E2E config compiles no src/ file, which is why "every
  // program includes src/shared" was false. Three separate passes over this PR
  // asserted the universal anyway, so pin the exception rather than trusting
  // the next reader to re-derive it. Widening this include is allowed — but it
  // falsifies that comment, and this is what makes that visible.
  it("keeps the E2E program free of src/, as the perf-flag comment states", () => {
    const e2e = JSON.parse(
      readFileSync(fileURLToPath(new URL("../extension/tsconfig.json", import.meta.url)), "utf8")
    );
    expect(e2e.include.filter((p: string) => p.includes("src/"))).toEqual([]);
    // rootDir "." is what makes reaching into ../../src a TS6059 error rather
    // than a silent widening, so it is part of the same guarantee.
    expect(e2e.compilerOptions.rootDir).toBe(".");
  });

  it("runs that chain ahead of the bundle step", () => {
    // `build` emitting dist/ without the gate would restore the same silent
    // green: the bundle would ship from source no compiler ever looked at.
    //
    // Split into steps rather than substring-matching the script. "pnpm
    // compile" is a PREFIX of "pnpm compile:webview", which `build` also runs,
    // so toContain("pnpm compile") stays green after the compile step is
    // deleted outright — the same trap this file calls out for `tsc -p ./`
    // above, and it was live here until the cycle-2 simplify pass caught it.
    const steps: string[] = pkg.scripts.build.split("&&").map((s: string) => s.trim());
    expect(steps).toContain("pnpm compile");
    expect(steps.indexOf("pnpm compile")).toBeLessThan(
      steps.findIndex((s: string) => s.includes("esbuild.config.mjs"))
    );
  });
});
