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
// The pattern below is deliberately wider than the canonical spelling: tsc also
// honours indented, space-less, triple-slash, case-variant and colon-suffixed
// forms (measured, tsc 5.9.3), and missing one of those would let an unchecked
// file read as checked — the exact trap this guard exists to close. Block
// comments and mid-line prose are NOT honoured by tsc and are correctly not
// matched, which is why the check is anchored per line rather than run over the
// whole file: this very file names the directive in prose several times.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Mirrors the roster grep in CLAUDE.md and tsconfig.json's header — keep the
// three in step if the directive grammar ever widens.
const DIRECTIVE = /^[ \t]*\/\/\/?[ \t]*@ts-nocheck([ \t]|:|$)/im;

const suites = readdirSync(HERE).filter((f) => f.endsWith(".ts"));

describe("test/build carries no file-level type-check opt-out", () => {
  it("finds the suites to scan (guards against an empty, vacuously-passing sweep)", () => {
    expect(suites.length).toBeGreaterThan(5);
  });

  it("reports no suite that switches its whole file off", () => {
    const offenders = suites.filter((f) => DIRECTIVE.test(readFileSync(join(HERE, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("matches the directive forms tsc honours, and only those", () => {
    const accepted = [
      "// @ts-nocheck",
      "//@ts-nocheck",
      "  // @ts-nocheck — trailing prose",
      "/// @ts-nocheck",
      "// @TS-NoCheck",
      "// @ts-nocheck: because",
    ];
    const rejected = [
      "/* @ts-nocheck */",
      "// swapping the @ts-nocheck for a line-scoped directive",
      "const s = '@ts-nocheck';",
    ];
    for (const line of accepted) {
      expect(DIRECTIVE.test(line)).toBe(true);
    }
    for (const line of rejected) {
      expect(DIRECTIVE.test(line)).toBe(false);
    }
  });
});
