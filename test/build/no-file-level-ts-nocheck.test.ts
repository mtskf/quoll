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
// Detection asks TypeScript rather than pattern-matching the source, because
// every form tsc honours but the scan misses is a file that reads as checked
// while being fully unchecked — the exact trap this guard exists to close.
// Which forms count, and which encodings the sweep can read, are settled by the
// fixtures below rather than by any sentence in this file: three cycles of this
// PR's review shipped a comment asserting coverage the code did not have.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

// Ask TypeScript instead of reimplementing its scanner.
//
// This guard's question is exactly "does tsc consider this file opted out?", so
// the faithful oracle is tsc itself. Three approximations of tsc's SCANNER were
// tried in this PR and all three were wrong, each one measured only after it
// shipped: a whole-file block-comment strip that swallowed live directives, a
// leading-trivia walk that stopped at a shebang, and a whitespace class that
// missed U+0085 and U+200B. (The tsconfig header counts four misses because it
// includes the read layer below, which is a different mistake in the same
// shape.) Every fix asserted the next approximation was complete.
// None were, and the failure direction is always the dangerous one — a file
// reported clean while tsc has switched checking off.
//
// ⚠️ `checkJsDirective` is not in typescript's public `.d.ts`, hence the cast.
// The risk that an upgrade removes it is real, but it fails LOUD rather than
// silent: the fixtures below assert a canonical `// @ts-nocheck` IS detected, so
// the field disappearing turns this suite red instead of quietly passing every
// file (verified by deleting the property from a parsed source file).
type SourceFileWithDirective = ts.SourceFile & { checkJsDirective?: { enabled: boolean } };

const detectsOptOut = (source: string): boolean => {
  const parsed = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.ESNext);
  return (parsed as SourceFileWithDirective).checkJsDirective?.enabled === false;
};

// Recursive on purpose: `tsconfig.json` includes `**/*.ts` and vitest includes
// `test/**/*.test.ts`, so a future `test/build/<subdir>/foo.test.ts` sits inside
// the very program this tripwire protects (nested test directories are already
// established here — see `test/extension/e2e/`). A top-level-only sweep would
// let such a suite opt out with no signal anywhere.
//
// `encoding` is load-bearing for types, not decoration: without it the recursive
// overload of readdirSync widens to `string[] | Buffer[]` and the filter below
// stops compiling.
//
// The extension set is deliberately wider than `tsconfig.json`'s `**/*.ts`,
// which admits only `.ts` and `.d.ts` (measured). A `.mts` or `.d.mts` reached
// by an explicit `./x.mjs` import IS a program input, and there it opts out the
// same two ways a `.ts` does — an honoured directive, or `skipLibCheck` on a
// declaration. Sweeping a file the program does not contain costs a false
// alarm; missing one costs the thing this guard exists to prevent.
const collectSuites = (root: string) =>
  readdirSync(root, { encoding: "utf8", recursive: true }).filter((f) => /\.[cm]?tsx?$/.test(f));

// Reading the bytes the way tsc reads them is part of the oracle, not plumbing
// around it. `sys.readFile` sniffs the byte order mark before the scanner runs:
// it decodes UTF-16LE/BE natively and strips a UTF-8 BOM, so tsc checks a
// different string than `readFileSync(f, "utf8")` returns. Both differences are
// silent misses in the dangerous direction — a UTF-16 suite arrives as mojibake
// and matches nothing, and a UTF-8 BOM shifts a shebang off offset 0, where
// tsc's scanner is the only place `#!` is legal, so the directive under it
// stops reading as leading trivia (measured against tsc 5.9.3: the directive IS
// honoured, the naive read says it is not).
const readAsTypeScriptWould = (path: string): string => {
  // Uint8Array rather than Buffer: @types/node 20 types `Buffer` as
  // `Uint8Array<ArrayBufferLike>`, which TS 5.9's lib rejects wherever an
  // `ArrayBuffer`-backed view is required (`Buffer.from`, `writeFileSync`).
  // Working in the plain view type and reaching for Buffer only to decode keeps
  // that friction out of the guard.
  const bytes = new Uint8Array(readFileSync(path));
  const decode = (view: Uint8Array, encoding: "utf8" | "utf16le") =>
    Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString(encoding);

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16BE. Node ships no decoder for it, so mirror what tsc does: drop the
    // mark, ignore a trailing odd byte, byte-swap into LE. `Buffer.from` copies,
    // so the in-place swap never touches `bytes`. The odd-byte trim is not
    // cosmetic — `swap16` throws on an odd length.
    const body = bytes.subarray(2);
    return Buffer.from(body.subarray(0, body.length - (body.length % 2)))
      .swap16()
      .toString("utf16le");
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decode(bytes.subarray(2), "utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decode(bytes.subarray(3), "utf8");
  }
  return decode(bytes, "utf8");
};

// The one sweep the guard actually performs — shared so the subdirectory suite
// below pins this exact path rather than a look-alike re-implementation.
//
// Scope is this directory only, which is narrower than the program it guards:
// `tsconfig.json` also includes `../../src/shared/**/*.ts`, and a directive
// there would switch those files off in this project and in `tsc -p ./` alike.
// That is a repo-wide guard rather than a test/build one, and it is filed as
// such; do not read this sweep as covering it.
const findOptOuts = (root: string) =>
  collectSuites(root).filter((f) => detectsOptOut(readAsTypeScriptWould(join(root, f))));

const suites = collectSuites(HERE);

describe("test/build carries no file-level type-check opt-out", () => {
  it("finds the suites to scan (guards against an empty, vacuously-passing sweep)", () => {
    expect(suites.length).toBeGreaterThan(5);
  });

  it("reports no suite that switches its whole file off", () => {
    expect(findOptOuts(HERE)).toEqual([]);
  });

  it("carries no declaration file, which would be unchecked with no directive", () => {
    // A second way to be unchecked, reached without any directive at all:
    // `tsconfig.base.json` sets `skipLibCheck: true`, `include` is `**/*.ts`
    // which matches `.d.ts`, and tsc's `skipTypeCheckingWorker` short-circuits
    // on `skipLibCheck && isDeclarationFile` BEFORE it ever reads
    // `checkJsDirective` — so no improvement to the detector above can reach
    // this case. Measured on tsc 5.9.3: a planted TS2339 in a `.d.ts` here is
    // reported with `skipLibCheck: false` and suppressed with it on.
    //
    // There is no such file today. If one is ever wanted, this line is where
    // the exemption gets made consciously rather than by drifting in.
    expect(suites.filter((f) => /\.d\.[cm]?ts$/.test(f))).toEqual([]);
  });

  it("detects the directive forms pinned below", () => {
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
      // The two forms this PR shipped a miss on: tsc counts them as leading
      // whitespace, JS `\s` does not. Their rejected counterparts sit in the
      // look-alike list below — the asymmetry with NBSP is real, not a typo.
      "\u{0085}// @ts-nocheck",
      "\u{200B}// @ts-nocheck",
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
      // Between the slashes and the `@`, tsc's pragma matcher accepts NBSP (see
      // the honoured list) but not these two.
      "//\u{0085}@ts-nocheck",
      "//\u{200B}@ts-nocheck",
    ];
    for (const source of notHonoured) {
      expect(detectsOptOut(source)).toBe(false);
    }
  });

  it("ignores a directive placed after code, exactly as tsc does", () => {
    // An earlier version flagged this deliberately, on the theory that a false
    // alarm is cheap. Dropped with the hand-rolled scan: tsc leaves such a file
    // fully CHECKED, so there is no vacuity to catch, and the extra arm was one
    // more approximation to get wrong. If someone later moves the directive to
    // the top — where it does bite — the sweep catches it there.
    expect(detectsOptOut("export const y = 1;\n// @ts-nocheck")).toBe(false);
  });

  it("still detects the canonical form, so an upstream API change fails loud", () => {
    // `checkJsDirective` is internal to typescript. Its removal would make
    // `detectsOptOut` return false for every file — a guard that silently passes
    // everything, the exact failure mode this tripwire exists to prevent. The
    // honoured list above catches that too; this test exists so the red suite
    // names the cause instead of making a reader diff 24 fixtures.
    expect(detectsOptOut("// @ts-nocheck")).toBe(true);
  });
});

describe("the sweep reads files the way tsc does", () => {
  // tsc never hands its scanner raw bytes, so neither can this guard. Each
  // fixture below is an encoding a file in this tree could genuinely arrive in,
  // and each was measured to have its directive honoured by tsc 5.9.3.
  const DIRECTIVE = "// @ts-nocheck\nexport const a: string = 1;\n";

  // Built from char codes rather than from the reader's own byte-swap, so the
  // UTF-16BE case is checked against an independent encoder and not against a
  // mirror of the code under test.
  const utf16be = (text: string): Uint8Array => {
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      out[i * 2] = code >> 8;
      out[i * 2 + 1] = code & 0xff;
    }
    return out;
  };

  const bytesOf = (text: string, encoding: "utf8" | "utf16le") =>
    new Uint8Array(Buffer.from(text, encoding));

  const concat = (mark: Uint8Array, body: Uint8Array) => {
    const out = new Uint8Array(mark.length + body.length);
    out.set(mark);
    out.set(body, mark.length);
    return out;
  };

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quoll-nocheck-encoding-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (name: string, bytes: Uint8Array) => {
    writeFileSync(join(root, name), bytes);
    return join(root, name);
  };

  it("strips a UTF-8 BOM, so a shebang still sits at offset 0", () => {
    // The compound case. With the BOM left in place `#!` lands at offset 1,
    // where tsc's scanner does not accept it, so everything below stops
    // counting as leading trivia — while tsc, reading the stripped text,
    // honours the directive.
    const path = write(
      "bom-shebang.test.ts",
      concat(Uint8Array.of(0xef, 0xbb, 0xbf), bytesOf(`#!/usr/bin/env node\n${DIRECTIVE}`, "utf8"))
    );

    expect(detectsOptOut(readAsTypeScriptWould(path))).toBe(true);
    // The naive read this replaced, pinned as the reason the read layer exists.
    expect(detectsOptOut(readFileSync(path, "utf8"))).toBe(false);
    expect(findOptOuts(root)).toEqual(["bom-shebang.test.ts"]);
  });

  it("decodes UTF-16LE", () => {
    write("utf16le.test.ts", concat(Uint8Array.of(0xff, 0xfe), bytesOf(DIRECTIVE, "utf16le")));

    expect(findOptOuts(root)).toEqual(["utf16le.test.ts"]);
  });

  it("decodes UTF-16BE", () => {
    write("utf16be.test.ts", concat(Uint8Array.of(0xfe, 0xff), utf16be(DIRECTIVE)));

    expect(findOptOuts(root)).toEqual(["utf16be.test.ts"]);
  });

  it("decodes UTF-16BE with a trailing odd byte, as tsc does", () => {
    // tsc truncates the odd tail (`len &= ~1`) and reads the rest. Without the
    // matching trim the read layer throws ERR_INVALID_BUFFER_SIZE instead of
    // answering — loud, but still a file the sweep never reports on. This is the
    // only fixture that reaches the byte-swap branch with an odd body, so it is
    // the one that goes red if a future pass decides the trim is a no-op.
    write(
      "utf16be-odd.test.ts",
      concat(concat(Uint8Array.of(0xfe, 0xff), utf16be(DIRECTIVE)), Uint8Array.of(0x41))
    );

    expect(findOptOuts(root)).toEqual(["utf16be-odd.test.ts"]);
  });

  it("detects a plain UTF-8 file, the no-decoding control", () => {
    write("plain.test.ts", bytesOf(DIRECTIVE, "utf8"));

    expect(findOptOuts(root)).toEqual(["plain.test.ts"]);
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

  it("collects the extensions the program can reach, not just test files", () => {
    // What the `.d.*` assertion above silently depends on. Every other fixture
    // in this file is named `*.test.ts`, so narrowing the collector to that
    // suffix would leave the whole suite green while the declaration check
    // degenerated to `expect([]).toEqual([])` and a non-test helper stopped
    // being swept.
    writeFileSync(join(root, "types.d.ts"), "export declare const a: string;\n");
    writeFileSync(join(root, "types.d.mts"), "export declare const b: string;\n");
    writeFileSync(join(root, "helper.ts"), "// @ts-nocheck\nexport const c = 1;\n");
    writeFileSync(join(root, "helper.mts"), "// @ts-nocheck\nexport const d = 1;\n");

    expect(collectSuites(root).sort()).toEqual([
      "helper.mts",
      "helper.ts",
      "types.d.mts",
      "types.d.ts",
    ]);
    expect(findOptOuts(root).sort()).toEqual(["helper.mts", "helper.ts"]);
  });

  it("flags an opt-out that hides in a subdirectory", () => {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "sneaky.test.ts"), "// @ts-nocheck\nexport const a = 1;\n");

    expect(findOptOuts(root)).toEqual([join("nested", "sneaky.test.ts")]);
  });
});
