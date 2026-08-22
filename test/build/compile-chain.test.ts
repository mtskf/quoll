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
//
// What this does NOT cover — measured, so nobody assumes wider protection than
// exists. It pins the CHAIN, not the contents of each link: shrinking a
// project's `include`, setting `noCheck`, or flipping `strict` in
// tsconfig.base.json all leave these four assertions green (the E2E `include`
// check below is the one exception, and only for that config). Nor does it pin
// its own execution path — the vitest `include` and the CI wiring that runs
// `pnpm test` could stop invoking this file. And dist/ can still be produced
// outside the gate by `pnpm watch` or a direct esbuild call, which is by
// design; the release path is safe only because ci.yml and publish.yml both go
// through `pnpm build`, and that wiring is outside this file's guarantee.
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

// tsconfig files in this repo are JSONC. Only lines that are ENTIRELY a `//`
// comment are dropped: a strip-to-end-of-line would corrupt a `//` sitting
// inside a string literal (a URL, a protocol-relative path). Block comments and
// trailing commas are still unsupported and would throw — no config here uses
// them. Without this, adding a doc comment to a config read below turns a clean
// assertion failure into a SyntaxError, i.e. a doc edit breaking `pnpm test`.
const parseJsonc = (source: string) =>
  JSON.parse(
    source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n")
  );

describe("pnpm compile project chain", () => {
  it("type-checks exactly the five reviewed projects, &&-chained with nothing else", () => {
    // Pin the WHOLE script by exact equality rather than extracting its `-p`
    // arguments. A partial extraction never sees what sits between and around
    // the steps, so all of these stay green while the gate is dead:
    // `tsc -p X ; tsc -p Y` (in sh the exit status is the LAST command's, which
    // demotes the first four projects to non-gates), `tsc -p X || true`, and an
    // `echo` in front of a step. Substring matching is weaker still — a bare
    // `toContain("tsc -p ./")` is satisfied by any of the four nested projects,
    // so the root pin would never go red.
    expect(pkg.scripts.compile).toBe(CHAINED_PROJECTS.map((p) => `tsc -p ${p}`).join(" && "));
  });

  // The scoped claim in src/shared/quoll-perf-flag.d.ts names this program as
  // THE exception: the E2E config compiles no src/ file, which is why "every
  // program includes src/shared" was false. Three separate passes over this PR
  // asserted the universal anyway, so pin the exception rather than trusting
  // the next reader to re-derive it. Widening this include is allowed — but it
  // falsifies that comment, and this is what makes that visible.
  it("keeps the E2E program free of src/, as the perf-flag comment states", () => {
    const e2e = parseJsonc(
      readFileSync(fileURLToPath(new URL("../extension/tsconfig.json", import.meta.url)), "utf8")
    );
    // Match `src` as a whole path SEGMENT: a bare directory include spelled
    // "../../src" (no trailing slash) is valid tsconfig and pulls in the same
    // files, but `includes("src/")` does not see it.
    expect(e2e.include.filter((p: string) => /(^|\/)src(\/|$)/.test(p))).toEqual([]);
    // rootDir "." is what makes reaching into ../../src a TS6059 error rather
    // than a silent widening, so it is part of the same guarantee.
    expect(e2e.compilerOptions.rootDir).toBe(".");
  });

  it("reaches the bundle step only through both type-check gates", () => {
    // `build` emitting dist/ without the gates would restore the same silent
    // green: the bundle would ship from source no compiler ever looked at.
    // BOTH gates are load-bearing. `compile` covers the host and test
    // programs — including two that DO compile src/webview (test/webview,
    // test/webview-browser), so `compile:webview` is not the only tsc pass
    // over that source. It is the only one that checks it under the ambient
    // view it actually ships with (`types: ["vscode-webview"]`, no node),
    // which is what catches webview code reaching for a Node global; the
    // others widen or empty `types`. Pinning `compile` alone once left that
    // check free to drift while this test stayed green.
    //
    // Pinned by exact equality, like `compile`, because every weaker shape
    // tried here turned out to be bypassable. Splitting on `&&` and comparing
    // indices cannot see short-circuiting, so it accepted
    // `… && false || node esbuild…`. Pinning only the leading prefix left the
    // tail free, so it accepted `… --production || node esbuild…` (bundles
    // ungated when a gate fails) and `… --production || true` (exits 0 on a
    // failed type-check). The obvious next patch — reject `[&|;\n]` in the
    // tail — is a denylist, and this file's whole history is denylists missing
    // a case: it would still admit `>`, `$(…)`, backticks and `#`. Exact
    // equality has no such gap.
    //
    // The cost is deliberate: changing `build` now requires updating this
    // string. `compile` already carries that same contract, and the measured
    // price is nil — `build` has not changed since the initial commit.
    expect(pkg.scripts.build).toBe(
      "pnpm compile && pnpm compile:webview && node esbuild.config.mjs --production"
    );
  });

  it("keeps compile:webview a real tsc pass", () => {
    // `build` calling `compile:webview` means nothing if that script stops
    // type-checking: `"echo skip"` or a trailing `|| true` leaves every other
    // assertion here green while the ONLY tsc pass over src/webview disappears
    // — the same accident this file exists to catch, one level down. The body
    // is pinned exactly, matching the treatment `compile` already gets.
    expect(pkg.scripts["compile:webview"]).toBe("tsc -p ./src/webview");
  });
});
