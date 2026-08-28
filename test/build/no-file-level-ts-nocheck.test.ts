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
// Detection walks the file's leading trivia the way tsc does, rather than
// pattern-matching lines, because every form tsc honours but the scan misses is
// a file that reads as checked while being fully unchecked — the exact trap this
// guard exists to close. The accept/reject sets below were measured against this
// repo's own tsc (5.9.3) by planting a type error behind each form and watching
// whether tsc suppressed it; `detectsOptOut` reproduces that verdict for every
// one of them.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Mirrors the character classes in tsc's own pragma matcher
// (`singleLinePragmaRegEx = /^\/\/\/?\s*@([^\s:]+)((?:[^\S\r\n]|:).*)?$/m`):
// `[^\S\r\n]` is "whitespace except newlines", which covers NBSP, form feed,
// vertical tab and a stray BOM. ASCII `[ \t]` misses all four — and a BOM is the
// realistic one, since an editor configured to write it produces a byte-perfect
// canonical directive that `readFileSync` still reports with `﻿` in front.
// Applied to one already-isolated comment line, never to a whole file.
const PRAGMA = /^\/\/\/?[^\S\r\n]*@ts-nocheck(?:[^\S\r\n]|:|$)/i;

const LEADING_WS = /\s*/y;
const LINE_END = /[\r\n\u2028\u2029]/g;

// The authority. tsc honours a `@ts-nocheck` pragma only from a file's LEADING
// trivia — an optional shebang, then whitespace and comments, up to the first
// real token — so this walks that region and stops at the first token.
// ⚠️ "Mirrors tsc" is a goal, not a proven property: the walk is validated
// against a measured probe corpus, and the shebang case below was found only
// after an earlier version claimed to reproduce the honour region exactly.
// Treat an unmodelled trivia form as a live possibility, not an impossibility. Block comments are
// trivia too, which is why `/* head */ // @ts-nocheck` and its multi-line form
// are honoured and reached here (measured, tsc 5.9.3).
//
// ⚠️ Walking is not over-engineering: the obvious shortcut — strip `/* … */`
// from the whole file, then scan lines — is UNSOUND. `/*` also occurs inside
// LINE comments, which are leading trivia too, so a header mentioning a glob
// like `**/*.ts` plus any later `*/` makes the strip swallow the directive
// sitting between them and report the file clean while tsc has switched it off
// (measured). This file's own header contains that glob three times.
const leadingTriviaOptsOut = (source: string): boolean => {
  // A shebang is trivia too, but only at offset 0 — tsc's scanner accepts `#!`
  // nowhere else. Without this the walk mistakes `#` for the first real token
  // and bails before ever reaching the directive below it (measured).
  let i = 0;
  if (source.startsWith("#!")) {
    LINE_END.lastIndex = 0;
    i = LINE_END.exec(source)?.index ?? source.length;
  }
  while (i < source.length) {
    LEADING_WS.lastIndex = i;
    LEADING_WS.exec(source);
    i = LEADING_WS.lastIndex;

    if (source.startsWith("//", i)) {
      LINE_END.lastIndex = i;
      const end = LINE_END.exec(source)?.index ?? source.length;
      if (PRAGMA.test(source.slice(i, end))) {
        return true;
      }
      i = end;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) {
        return false; // unterminated: the rest of the file is comment body
      }
      i = close + 2;
      continue;
    }
    return false; // first real token — nothing past here is honoured
  }
  return false;
};

// A directive sitting after code is NOT honoured by tsc, but it is almost
// always someone's mistaken attempt to opt out, so it is flagged anyway: a
// false alarm gets read by a human, a missed opt-out gets read by nobody.
// ⚠️ Best-effort only, and deliberately not a second safety net — it inherits
// the unsound whole-file strip described above, so it can miss. Everything that
// actually matters for correctness is decided by the walker.
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const AFTER_CODE_DIRECTIVE = /^[^\S\r\n]*\/\/\/?[^\S\r\n]*@ts-nocheck(?:[^\S\r\n]|:|$)/im;

const detectsOptOut = (source: string) =>
  leadingTriviaOptsOut(source) || AFTER_CODE_DIRECTIVE.test(source.replace(BLOCK_COMMENT, ""));

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
      // A `/*` inside a LINE comment is still leading trivia, so tsc honours the
      // directive below it. These three defeated the earlier whole-file
      // block-comment strip, which swallowed everything up to the trailing `*/`.
      '// /*\n// @ts-nocheck\nconst x: string = 1;\nconst s = "*/";',
      '// covers **/*.ts\n// @ts-nocheck\nexport const p = "test/**/*.test.ts";',
      "// header /*\n// @ts-nocheck\nconst x: string = 1;\n/* real trailing comment */",
      // A shebang is trivia at offset 0, so the directive under it is still
      // honoured. Combined with the glob above, this defeated BOTH arms of an
      // earlier attempt: the walk stopped at `#`, and the strip ate the rest.
      "#!/usr/bin/env node\n// @ts-nocheck",
      '#!/usr/bin/env node\n// covers **/*.ts\n// @ts-nocheck\nexport const p = "test/**/*.test.ts";',
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
