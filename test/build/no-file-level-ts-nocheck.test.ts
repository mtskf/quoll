// Tripwire for the file-level type-check opt-out in this directory.
//
// `test/build/tsconfig.json` type-checks these suites under `pnpm compile`, but
// a file-level nocheck directive switches its whole file off — so a suite that
// reaches for one to silence a single untyped `scripts/*.mjs` import loses
// enforcement everywhere else in the file, and any type-level assertion it
// carries goes permanently vacuous while `pnpm compile`, `pnpm test` and CI all
// stay green. Five suites lived in exactly that state between the tsconfig
// landing (2026-08-22) and the swap to line-scoped directives (2026-08-28);
// nothing but this test stops them drifting back.
//
// The supported shape is a line-scoped `@ts-expect-error` on the import's
// module specifier — it self-verifies (goes red the day the module gains types)
// and leaves everything the test itself authors checked. When the binding list
// would wrap and push the specifier off the directive's line, use a namespace
// import and destructure below; theme-palettes.test.ts documents why.
//
// Detection is deliberately wider than the canonical spelling, because every
// form tsc honours but the scan misses is a file that reads as checked while
// being fully unchecked — the exact trap this guard exists to close. The
// accept/reject sets below were measured against this repo's own tsc (5.9.3) by
// planting a type error behind each form and watching whether tsc suppressed it;
// `detectsOptOut` reproduces that verdict for every one of them.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Block comments are trivia to tsc exactly like line comments, so a directive
// that trails one on the same line — `/* head */ // @ts-nocheck`, including the
// multi-line `/*\n * …\n */ // @ts-nocheck` shape — IS honoured (measured).
// Stripping block comments before the per-line scan models that directly and
// reads better than a regex trying to re-derive it.
// ⚠️ A `/*` inside a string literal would make this strip too much. That cannot
// hide a live directive: a string literal is a token, and tsc only honours the
// pragma from trivia BEFORE the first token, so anything the over-strip could
// swallow was never honoured to begin with.
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;

// Mirrors the character classes in tsc's own pragma matcher
// (`singleLinePragmaRegEx = /^\/\/\/?\s*@([^\s:]+)((?:[^\S\r\n]|:).*)?$/m`):
// `[^\S\r\n]` is "whitespace except newlines", which covers NBSP, form feed,
// vertical tab and a stray BOM. ASCII `[ \t]` misses all four — and a BOM is the
// realistic one, since an editor configured to write it produces a byte-perfect
// canonical directive that `readFileSync` still reports with `﻿` in front.
const DIRECTIVE = /^[^\S\r\n]*\/\/\/?[^\S\r\n]*@ts-nocheck(?:[^\S\r\n]|:|$)/im;

const detectsOptOut = (source: string) => DIRECTIVE.test(source.replace(BLOCK_COMMENT, ""));

// Recursive on purpose: `tsconfig.json` includes `**/*.ts` and vitest includes
// `test/**/*.test.ts`, so a future `test/build/<subdir>/foo.test.ts` sits inside
// the very program this tripwire protects (nested test directories are already
// established here — see `test/extension/e2e/`). A top-level-only sweep would
// let such a suite opt out with no signal anywhere.
//
// `encoding` is load-bearing for types, not decoration: without it the recursive
// overload of readdirSync widens to `string[] | Buffer[]` and the filter below
// stops compiling.
const collectSuites = (root: string) =>
  readdirSync(root, { encoding: "utf8", recursive: true }).filter((f) => f.endsWith(".ts"));

// The one sweep the guard actually performs — shared so the subdirectory suite
// below pins this exact path rather than a look-alike re-implementation.
const findOptOuts = (root: string) =>
  collectSuites(root).filter((f) => detectsOptOut(readFileSync(join(root, f), "utf8")));

const suites = collectSuites(HERE);

describe("test/build carries no file-level type-check opt-out", () => {
  it("finds the suites to scan (guards against an empty, vacuously-passing sweep)", () => {
    expect(suites.length).toBeGreaterThan(5);
  });

  it("reports no suite that switches its whole file off", () => {
    expect(findOptOuts(HERE)).toEqual([]);
  });

  it("detects every directive form tsc honours", () => {
    // Each string is the file prefix from the corresponding tsc probe; every one
    // of them suppressed a planted TS2322 under tsc 5.9.3.
    const honoured = [
      "// @ts-nocheck",
      "//@ts-nocheck",
      "\t// @ts-nocheck",
      "/// @ts-nocheck",
      "// @TS-NoCheck",
      "// @ts-nocheck: because",
      "  // @ts-nocheck — trailing prose",
      "// @ts-nocheck\r\n",
      "\n\n// @ts-nocheck",
      "\u{FEFF}// @ts-nocheck",
      "//\u{00A0}@ts-nocheck",
      "\u{00A0}// @ts-nocheck",
      "// @ts-nocheck\u{00A0}because",
      "\u{000C}// @ts-nocheck",
      "\u{000B}// @ts-nocheck",
      "/* head */ // @ts-nocheck",
      "/*\n * header\n */ // @ts-nocheck",
    ];
    for (const source of honoured) {
      expect(detectsOptOut(source)).toBe(true);
    }
  });

  it("ignores look-alikes tsc does not honour", () => {
    // Measured the same way: tsc reported the planted TS2322 behind each of
    // these, so treating them as an opt-out would be a false alarm.
    const notHonoured = [
      "/* @ts-nocheck */",
      "/*\n * // @ts-nocheck is bad\n */",
      "////@ts-nocheck",
      "const x = 1; // @ts-nocheck",
      "// swapping the @ts-nocheck for a line-scoped directive",
      "const s = '@ts-nocheck';",
    ];
    for (const source of notHonoured) {
      expect(detectsOptOut(source)).toBe(false);
    }
  });

  it("over-matches a directive placed after code, which fails loud rather than silent", () => {
    // tsc only honours the pragma from a file's leading trivia, so it ignores
    // this one — the scan still flags it. Documented rather than fixed: a false
    // alarm is read by a human, a missed opt-out is read by nobody.
    expect(detectsOptOut("export const y = 1;\n// @ts-nocheck")).toBe(true);
  });
});

describe("the sweep descends into subdirectories", () => {
  let root: string;

  beforeEach(() => {
    // Built under the OS temp dir, never in the repo: a stray `.ts` in the shared
    // work tree is picked up by `tsconfig.json`'s `**/*.ts` and breaks other
    // agents' type-checks.
    root = mkdtempSync(join(tmpdir(), "quoll-nocheck-sweep-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns nested suites, not just the top level", () => {
    writeFileSync(join(root, "top.test.ts"), "");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "deep.test.ts"), "");

    expect(collectSuites(root).sort()).toEqual([join("nested", "deep.test.ts"), "top.test.ts"]);
  });

  it("flags an opt-out that hides in a subdirectory", () => {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "sneaky.test.ts"), "// @ts-nocheck\nexport const a = 1;\n");

    expect(findOptOuts(root)).toEqual([join("nested", "sneaky.test.ts")]);
  });
});
