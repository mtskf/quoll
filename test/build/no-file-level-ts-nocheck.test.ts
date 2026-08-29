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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HERE = dirname(fileURLToPath(import.meta.url));

const findConfigFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : findConfigFiles(join(dir, entry.name));
    }
    return /^tsconfig(\..+)?\.json$/.test(entry.name) ? [join(dir, entry.name)] : [];
  });

// Directories a tsc program never reads from and a sweep must not walk into.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out", ".vscode-test", "coverage"]);

// `tsc -p` on the COMMAND LINE accepts a directory or a file. This mirrors that
// one documented CLI rule, and nothing else — in particular it is not used to
// resolve `extends`, which has different rules (see below).
const resolveCliProjectTarget = (target: string): string =>
  target.endsWith(".json") ? resolve(target) : resolve(target, "tsconfig.json");

// Read every config once, and let tsc say which of them are `extends` targets.
//
// The rule is: a config that another config extends is treated as an options
// carrier, not a program.
//
// ⚠️ That is a HEURISTIC, not a theorem, and the plan says so rather than
// pretending otherwise: a config can legitimately be both a base for one
// project and a project someone runs `tsc -p` on. Such a config would be
// excluded here and its files would go unswept — except that both ways of
// noticing are loud, by construction:
//   - if it is wired into `pnpm compile` / `compile:webview`, the cross-check
//     below goes red (it reads the scripts, not this classification);
//   - otherwise it drops out of the roster assertion above, which goes red.
// Both are loud rather than silent, which is the property being bought here.
// Note what is NOT claimed: a red roster CAN be made green by deleting the
// entry, so this is a prompt for a human to look, not a mechanism that forces
// a classifier fix. That is why the entry is a roster of what SHOULD be swept
// and not a snapshot of what IS — the two differ exactly when something is
// wrong. The heuristic holds for all eight configs in this repo today
// (measured).
//
// Sweeping a base instead of skipping it is not a harmless over-approximation:
// `tsconfig.base.json` declares no `include`, so on its own it resolves the
// DEFAULT include — measured at 570 files, among them `test/markdown` (29) and
// `test/shared` (4), which no real program type-checks. Directives there change
// nothing, so reporting them would be pure false alarm.
//
// Letting tsc resolve `extends` rather than reading the raw field is the same
// reflex as the rest of this guard, and the difference is measurable:
// `"extends": "./tsconfig.base"` without the `.json` is valid and resolves to
// `tsconfig.base.json`, while the obvious hand-rolled rule ("not `.json`? then
// it's a directory") produces `tsconfig.base/tsconfig.json`, misses, and
// promotes the base to a swept project.
const discoverProjects = (root: string): string[] => {
  const configs = findConfigFiles(root);
  const extended = new Set(configs.flatMap((config) => readProject(config).extendsTargets));
  return configs.filter((config) => !extended.has(config)).sort();
};

// Read one config, and keep the `TsConfigSourceFile` in hand.
//
// ⚠️ Do NOT reach for the source file back through `parsed.options.configFile`.
// `extendedSourceFiles` is public on `TsConfigSourceFile`, but `configFile` is
// reachable on `CompilerOptions` only through its index signature, so the
// property access lands on a union including `string` and fails to compile:
//
//   error TS2339: Property 'extendedSourceFiles' does not exist on type
//   'string | number | boolean | ... | TsConfigSourceFile'
//
// Measured on TS 5.9.3 under this repo's strictness — it would have taken
// `pnpm compile` down. Holding the source file from the start is both the fix
// and the smaller design: one read, both answers, and no cast anywhere.
const readProject = (configPath: string) => {
  // Read the bytes ourselves so an unreadable config is OUR error with OUR
  // filename in it. `ts.readJsonConfigFile` swallows a failed read and returns
  // an object with no `statements`, which then makes
  // `parseJsonSourceFileConfigFileContent` die on a raw
  // `TypeError: Cannot read properties of undefined (reading '0')` — loud, but
  // it names nothing. Reachable in practice: a config deleted or chmodded
  // between `findConfigFiles` listing it and this line.
  //
  // Reading it ourselves does not change how the bytes are decoded:
  // `ts.sys.readFile` IS the reader `readJsonConfigFile` would have called, so
  // BOM stripping and UTF-16 decoding are unchanged. Measured against tsc's own
  // `getParsedCommandLineOfConfigFile` on the same files — plain UTF-8, UTF-8
  // with a BOM, and UTF-16LE with a BOM all resolve identically through both.
  const text = ts.sys.readFile(configPath);
  if (text === undefined) {
    throw new Error(`${relative(REPO_ROOT, configPath)}: could not be read`);
  }
  const source = ts.readJsonConfigFile(configPath, () => text);
  const parsed = ts.parseJsonSourceFileConfigFileContent(
    source,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath
  );

  // ⚠️ `getConfigFileParsingDiagnostics`, NOT `parsed.errors`.
  //
  // This is the same class of mistake as everything else this guard has been
  // burned by, one layer up: `parsed.errors` is not the set of things wrong
  // with the config. JSON SYNTAX errors land on the source file, not in
  // `errors`, so a config truncated mid-object — `{"include":["**/*.ts"],` —
  // measures as `parseDiagnostics: [TS1005]` with `errors: []`, and a
  // `parsed.errors`-only check waves it through as a clean project with a
  // partial file list. `tsc -p` on the same file exits non-zero. That is the
  // silent-pass direction, in the one place the guard trusts a config.
  //
  // `getConfigFileParsingDiagnostics` is public (typescript.d.ts:9582) and is
  // defined as the concatenation tsc's own program construction reports:
  // the source file's parse diagnostics plus `errors`. Asking it is asking tsc.
  //
  // Measured to throw on: truncated JSON (TS1005), garbage JSON (TS1005 /
  // TS1327 / TS1328 / TS1136), self-circular `extends` (TS18000), a missing
  // `extends` target (TS5083), an unknown compiler option (TS5023), and an
  // `include` that matches nothing (TS18003) — that last one being a second,
  // independent guard on the per-project non-empty assertion in Task 1.
  const fatal = ts
    .getConfigFileParsingDiagnostics(parsed)
    .filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) {
    // Throw rather than return an empty file list: a config that stops parsing
    // must not degrade into "this project contributed no files", which reads
    // exactly like "this project is clean".
    throw new Error(
      `${relative(REPO_ROOT, configPath)}: ${fatal
        .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`)
        .join("; ")}`
    );
  }

  // ⚠️ ORDER IS LOAD-BEARING. `extendedSourceFiles` is `undefined` until
  // `parseJsonSourceFileConfigFileContent` has run — it is populated BY the
  // parse, not by the read (measured: `undefined` before, populated after).
  // Reading it earlier would classify every config as a leaf, promote
  // `tsconfig.base.json` to a swept project, and start reporting `test/markdown`
  // and `test/shared` — silently, since the `?? []` swallows the `undefined`.
  return { parsed, extendsTargets: source.extendedSourceFiles ?? [] };
};

// Repo-owned = under `root`, and not vendored.
//
// Every test here is on PATH SEGMENTS of the relative path, because each of the
// string-level shortcuts has a measured counter-example:
//   `startsWith(`${root}/`)`   matches `/repo-backup` under root `/repo`
//   `rel.startsWith("..")`      matches a real subdirectory named `..generated`
//   `.includes("/node_modules/")` hard-codes the separator
// The first two reject or accept the wrong file silently, which is the failure
// direction this guard exists to close.
//
// `node_modules` holds the lib files and @types packages every program pulls
// in; they are not ours to police, and a directive in one is upstream's
// business.
const repoRelative = (root: string, fileName: string): string | null => {
  const rel = relative(root, fileName);
  if (rel === "" || isAbsolute(rel)) {
    return null;
  }
  const segments = rel.split(sep);
  // `..` as a SEGMENT, not as a prefix: `rel.startsWith("..")` also rejects a
  // real subdirectory named `..generated` (measured — `relative()` returns
  // `..generated/a.ts`, which the prefix test calls an escape and the segment
  // test correctly does not). Rejecting a file the program contains is the
  // silent-pass direction, which is the whole failure class this guard exists
  // to close.
  if (segments[0] === "..") {
    return null;
  }
  // Same reasoning for vendored code: a segment test does not depend on the
  // separator, and does not fire on a directory merely named
  // `my_node_modules` (both measured).
  if (segments.includes("node_modules")) {
    return null;
  }
  return rel;
};

// `root` is both the containment boundary and the base for reported paths, so
// one function serves the repo sweep and the temp-dir fixtures with no second
// code path. Defaults to the repo so the repo-sweep call sites read plainly.
//
// ⚠️ Callers pass the root spelled the way the config path was spelled — see
// the measured note in Task 2 Step 4. tsc does not canonicalise, so
// `realpathSync`-ing one side and not the other silently empties the sweep.
const sweepProject = (configPath: string, root: string = REPO_ROOT) => {
  const { parsed } = readProject(configPath);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const files: string[] = [];
  const optOuts: string[] = [];
  const declarations: string[] = [];
  for (const source of program.getSourceFiles()) {
    const rel = repoRelative(root, source.fileName);
    if (rel === null) continue;
    files.push(rel);
    if ((source as SourceFileWithDirective).checkJsDirective?.enabled === false) optOuts.push(rel);
    if (source.isDeclarationFile) declarations.push(rel);
  }
  return { files: files.sort(), optOuts: optOuts.sort(), declarations: declarations.sort() };
};

// Merges results that were ALREADY swept — it does not sweep. Building each
// `ts.Program` costs 150–400 ms, so the describe body sweeps every project
// exactly once into a Map and hands the values here; a `sweepAll(configs)` that
// re-derived them would double that for no gain.
type Sweep = ReturnType<typeof sweepProject>;

const mergeSweeps = (sweeps: Sweep[]) => {
  const files = new Set<string>();
  const optOuts = new Set<string>();
  const declarations = new Set<string>();
  for (const swept of sweeps) {
    for (const f of swept.files) files.add(f);
    for (const f of swept.optOuts) optOuts.add(f);
    for (const f of swept.declarations) declarations.add(f);
  }
  return { files, optOuts: [...optOuts].sort(), declarations: [...declarations].sort() };
};

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

// Ask TypeScript which names it treats as declarations, for the same reason the
// directive oracle asks it rather than matching text: `.d.ts` is not the only
// spelling. tsc counts any `*.d.<tag>.ts` — the arbitrary-extension
// declaration form — as a declaration file, and `skipLibCheck` skips it exactly
// as it skips a plain `.d.ts`. `isDeclarationFile` is public API, unlike the
// directive field, and is derived from the filename alone.
const isDeclaration = (f: string) =>
  ts.createSourceFile(f, "", ts.ScriptTarget.ESNext).isDeclarationFile;

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
    expect(suites.filter(isDeclaration)).toEqual([]);
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

describe("the sweep collects what the program can reach", () => {
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
    writeFileSync(join(root, "types.d.cts"), "export declare const e: string;\n");
    writeFileSync(join(root, "types.d.css.ts"), "export declare const f: string;\n");
    writeFileSync(join(root, "helper.ts"), "// @ts-nocheck\nexport const c = 1;\n");
    writeFileSync(join(root, "helper.mts"), "// @ts-nocheck\nexport const d = 1;\n");
    writeFileSync(join(root, "helper.cts"), "// @ts-nocheck\nexport const g = 1;\n");
    writeFileSync(join(root, "helper.tsx"), "// @ts-nocheck\nexport const h = 1;\n");

    const collected = collectSuites(root).sort();
    expect(collected).toEqual([
      "helper.cts",
      "helper.mts",
      "helper.ts",
      "helper.tsx",
      "types.d.css.ts",
      "types.d.cts",
      "types.d.mts",
      "types.d.ts",
    ]);
    expect(collected.filter(isDeclaration)).toEqual([
      "types.d.css.ts",
      "types.d.cts",
      "types.d.mts",
      "types.d.ts",
    ]);
    expect(findOptOuts(root).sort()).toEqual([
      "helper.cts",
      "helper.mts",
      "helper.ts",
      "helper.tsx",
    ]);
  });

  it("flags an opt-out that hides in a subdirectory", () => {
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "sneaky.test.ts"), "// @ts-nocheck\nexport const a = 1;\n");

    expect(findOptOuts(root)).toEqual([join("nested", "sneaky.test.ts")]);
  });
});

describe("the sweep enumerates the repo's tsc programs, not a fixed directory", () => {
  it("registers every tsc program in the repo, and only the options base is left out", () => {
    // Discovery is automatic; REGISTRATION is deliberate. The list below is a
    // roster, not the enumeration — `discoverProjects` reads the filesystem and
    // asks tsc which configs are `extends` targets, and this assertion is where
    // a human acknowledges the answer. Adding a tsconfig therefore costs one
    // line here, on purpose: a new program puts new files under type-check, and
    // that is exactly the event this guard exists to make visible.
    //
    // (Reviewed and kept deliberately: an auto-discovered set with no roster
    // would silently accept a config that discovery misclassified, which is the
    // failure direction this whole tripwire exists to close. The cost is a
    // one-line edit roughly once a year — seven configs in the repo's life.)
    expect(discoverProjects(REPO_ROOT).map((p) => relative(REPO_ROOT, p))).toEqual([
      "src/webview/tsconfig.json",
      "test/build/tsconfig.json",
      "test/extension/tsconfig.json",
      "test/extension/tsconfig.unit.json",
      "test/webview-browser/tsconfig.json",
      "test/webview/tsconfig.json",
      "tsconfig.json",
    ]);
  });

  it("covers every project `pnpm compile` and `pnpm compile:webview` type-check", () => {
    // The cross-check that keeps the roster honest in the other direction: it
    // reads the compile gate rather than trusting the list above, so a config
    // wired into CI but dropped by discovery goes red even if someone updated
    // the roster to match the broken output.
    const scripts = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8")
    ).scripts as Record<string, string>;
    const referenced = [...`${scripts.compile} && ${scripts["compile:webview"]}`.matchAll(
      /tsc -p (\S+)/g
    )].map(([, target]) => resolveCliProjectTarget(join(REPO_ROOT, target)));

    // 5 from `compile`, 1 from `compile:webview` — pinned so a script edit that
    // drops a `tsc -p` invocation cannot quietly shrink what this test checks.
    expect(referenced.length).toBe(6);
    const discovered = new Set(discoverProjects(REPO_ROOT));
    expect(referenced.filter((r) => !discovered.has(r)).map((r) => relative(REPO_ROOT, r))).toEqual(
      []
    );
  });

  it("lets tsc resolve `extends`, including the extensionless form", () => {
    // The one place discovery could have re-implemented tsc, pinned so it
    // cannot drift back. `"extends": "./base"` (no `.json`) is valid and tsc
    // resolves it to `base.json`; a hand-rolled resolver that appends
    // `/tsconfig.json` to non-`.json` targets instead produces
    // `base/tsconfig.json`, fails to match, and promotes the base to a swept
    // project — whose default include is the whole repo, so `test/markdown` and
    // `test/shared` start raising false alarms.
    // ⚠️ The base MUST be named `tsconfig.base.json`, not `base.json`.
    // `findConfigFiles` matches /^tsconfig(\..+)?\.json$/, so a `base.json`
    // never enters discovery at all — and then this assertion holds whether
    // `extends` resolution works or is completely broken, i.e. it pins nothing.
    // (An earlier draft did exactly that; caught in review, not by the test.)
    // With the name below, a broken resolver leaves the base unmatched and
    // discovery returns BOTH files, so the assertion goes red for the right
    // reason.
    const root = mkdtempSync(join(tmpdir(), "quoll-nocheck-extends-"));
    try {
      writeFileSync(
        join(root, "tsconfig.base.json"),
        JSON.stringify({ compilerOptions: { noLib: true } })
      );
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({ extends: "./tsconfig.base", include: ["**/*.ts"] })
      );
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");

      expect(discoverProjects(root).map((p) => relative(root, p))).toEqual(["tsconfig.json"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("no file in any tsc program switches its whole file off", () => {
  // Built once, in the describe body, and shared by all four assertions.
  //
  // Two reasons this is not a detail. (a) Cost: each project is a full
  // `ts.Program`, ~150–400 ms; re-deriving per `it` would build all seven
  // twice. (b) Flake: vitest's default `testTimeout` is 5000 ms and this repo
  // deliberately runs uncapped parallel workers (see vitest.config.ts's note on
  // the ruled-out load-flake), so a multi-second body inside an `it` is exactly
  // the shape that goes intermittently red under contention. Collection-time
  // work carries no per-test timeout.
  const projects = discoverProjects(REPO_ROOT);
  const perProject = new Map(projects.map((p) => [relative(REPO_ROOT, p), sweepProject(p)]));
  const swept = mergeSweeps([...perProject.values()]);

  it("reaches the whole repo, not one directory (guards a vacuous sweep)", () => {
    // A floor, not an exact count — the union was 467 files when this landed,
    // and it moves with every source file added. What it pins is that the
    // sweep did not silently collapse: a broken config, a bad filter or an
    // enumeration that found nothing all land far below this.
    expect(swept.files.size).toBeGreaterThan(300);
    // Named anchors, one per layer, so "reaches the whole repo" is not just a
    // number. `protocol.ts` is the file the non-vacuity spike planted into;
    // the last two are only reachable transitively or from a narrow include.
    for (const anchor of [
      "src/extension/extension.ts",
      "src/markdown/validate-for-write.ts",
      "src/shared/protocol.ts",
      "src/webview/shell.ts",
      "test/build/no-file-level-ts-nocheck.test.ts",
      "test/extension/types-equality.test.ts",
      "test/webview-browser/harness-smoke.browser.test.ts",
    ]) {
      expect(swept.files.has(anchor)).toBe(true);
    }
  });

  it("reports no file that switches its whole file off", () => {
    expect(swept.optOuts).toEqual([]);
  });

  it("carries only the declaration files exempted on purpose", () => {
    // A second way to be unchecked, reached with no directive at all:
    // `tsconfig.base.json` sets `skipLibCheck: true`, and tsc's
    // `skipTypeCheckingWorker` short-circuits on
    // `skipLibCheck && isDeclarationFile` BEFORE it reads `checkJsDirective` —
    // so no improvement to the detector can reach this case.
    //
    // `quoll-perf-flag.d.ts` is an ambient declaration for a build-time flag;
    // it declares, it does not assert. Any addition to this list is a conscious
    // exemption made here rather than a file that drifted in.
    expect(swept.declarations).toEqual(["src/shared/quoll-perf-flag.d.ts"]);
  });

  it("gets a non-empty program from every project it discovered", () => {
    // Per-project, because the union hides a single dead config: one project
    // resolving to zero files still leaves the union in the hundreds.
    //
    // Asserted as the LIST OF OFFENDERS rather than a count comparison, so the
    // failure diff names the config that died. A `toBeGreaterThan(0)` in a loop
    // prints `0 > 0` and leaves the reader to work out which of the seven it
    // was.
    const empty = [...perProject].filter(([, swept]) => swept.files.length === 0).map(([p]) => p);

    expect(empty).toEqual([]);
  });
});
