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
    const compileScript: string = pkg.scripts.compile;
    // Pin the WHOLE script by exact equality rather than extracting its `-p`
    // arguments. A partial extraction never sees what sits between and around
    // the steps, so all of these stay green while the gate is dead:
    // `tsc -p X ; tsc -p Y` (in sh the exit status is the LAST command's, which
    // demotes the first four projects to non-gates), `tsc -p X || true`, and an
    // `echo` in front of a step. Substring matching is weaker still — a bare
    // `toContain("tsc -p ./")` is satisfied by any of the four nested projects,
    // so the root pin would never go red.
    expect(compileScript).toBe(CHAINED_PROJECTS.map((p) => `tsc -p ${p}`).join(" && "));
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
    // BOTH gates are pinned — `compile` covers the host and test programs, and
    // `compile:webview` is the only tsc pass over src/webview, which lands in
    // the same dist/webview/ output. Pinning `compile` alone left the webview
    // half free to drift behind esbuild while this test stayed green.
    //
    // Assert the required PREFIX rather than splitting into steps and checking
    // order. Splitting on `&&` cannot see shell short-circuiting, so it accepts
    // `pnpm compile && pnpm compile:webview && false || node esbuild…`: both
    // gates precede the bundle-bearing segment, yet `||` runs the bundler when
    // a gate fails. A prefix pin models what actually matters — the bundler is
    // reachable only through two successful `&&` gates.
    //
    // The prefix stops at the bundler's name on purpose: `build` is still
    // deliberately NOT pinned by exact equality, because the bundle step's
    // trailing flags are expected to move for ordinary reasons and only the
    // gating prefix is load-bearing.
    const REQUIRED_BUILD_PREFIX = "pnpm compile && pnpm compile:webview && node esbuild.config.mjs";
    const buildScript: string = pkg.scripts.build;
    // Compare a slice rather than asserting `startsWith(…)` is true: on failure
    // this reports the actual leading text against the expected prefix, where
    // the boolean form reports only `expected false to be true`.
    expect(buildScript.slice(0, REQUIRED_BUILD_PREFIX.length)).toBe(REQUIRED_BUILD_PREFIX);
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
