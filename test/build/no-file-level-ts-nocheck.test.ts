// Tripwire for the file-level type-check opt-out, repo-wide.
//
// It lives in test/build because that is where the trap was first sprung, but it
// sweeps every tsc program in the repo (see `discoverProjects`). It answers one
// question — "does tsc consider this file opted out?" — for the files a program
// CONTAINS. A file in no program is unchecked by a different mechanism and is
// out of this guard's reach. A file-level nocheck directive switches its whole
// file off, so a file that reaches for one loses enforcement everywhere else in
// it and any type-level assertion it carries goes permanently vacuous while
// `pnpm compile`, `pnpm test` and CI all stay green. Five suites in this
// directory lived in exactly that state between the tsconfig landing
// (2026-08-22) and the swap to line-scoped directives (2026-08-28); nothing but
// this test stops them, or any other file in the repo, drifting back.
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

const findConfigFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      // Mirror the one structural rule tsc's own `**` applies: it never
      // descends into a dot-prefixed directory, so no glob-included program can
      // live under one. Re-deriving that boundary as a growing denylist is how
      // a work-tree scratch project joins the roster — measured on this branch,
      // a `/review-cycle` reviewer's probe tsconfig under `.review-cycle-<id>/`
      // reddened the roster assertion, and an unparseable one took collection
      // for the whole file down (`0 test`). Pinned by the dot-directory fixture
      // below rather than left to this comment.
      return entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)
        ? []
        : findConfigFiles(join(dir, entry.name));
    }
    return /^tsconfig(\..+)?\.json$/.test(entry.name) ? [join(dir, entry.name)] : [];
  });

// Non-dot directories no tsconfig this repo OWNS lives under. Not a claim about
// what tsc reads — every program pulls its lib and @types files out of
// `node_modules` (see below) — and not the containment boundary either, which
// is `repoRelative`'s separate job over swept FILES. Dot-directories are
// skipped wholesale above, so `.git` and `.vscode-test` need no entry here.
const SKIP_DIRS = new Set(["node_modules", "dist", "out", "coverage"]);

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
// ⚠️ That is a HEURISTIC, not a theorem, and this comment says so rather than
// pretending otherwise: a config can legitimately be both a base for one
// project and a project someone runs `tsc -p` on. Such a config would be
// excluded here and its files would go unswept — except that both ways of
// noticing are loud, by construction:
//   - if it is wired into `pnpm compile` / `compile:webview`, the cross-check
//     below goes red (it reads the scripts, not this classification);
//   - otherwise it drops out of the roster assertion below ("registers every
//     tsc program in the repo"), which goes red.
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
// and the smaller design: one read, both answers, and no cast on this route.
const readProject = (configPath: string) => {
  // Read the bytes ourselves so an unreadable config is OUR error with OUR
  // filename in it. `ts.readJsonConfigFile` swallows a failed read and returns
  // an object with no `statements`, which then makes
  // `parseJsonSourceFileConfigFileContent` die on a raw
  // `TypeError: Cannot read properties of undefined (reading '0')` — loud, but
  // it names nothing. Reachable in practice: a config deleted or chmodded
  // between `findConfigFiles` listing it and this line.
  //
  // The message stays at "could not be read" on purpose: `ts.sys.readFile`
  // wraps a bare catch and returns `undefined` for missing, is-a-directory and
  // chmod-000 alike (all three measured), so naming a cause here would be a
  // guess. An EMPTY config is not this branch at all — it reads as `""`, parses
  // as a valid config, and resolves the default include from its own directory.
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
  // `getConfigFileParsingDiagnostics` is part of typescript's public `.d.ts`
  // (unlike `checkJsDirective` below) and is defined as the concatenation tsc's
  // own program construction reports: the source file's parse diagnostics plus
  // `errors`. Asking it is asking tsc.
  //
  // Measured to throw on: truncated JSON (TS1005), garbage JSON (TS1005 /
  // TS1327 / TS1328 / TS1136), self-circular `extends` (TS18000), a missing
  // `extends` target (TS5083), an unknown compiler option (TS5023), and an
  // `include` that matches nothing (TS18003) — that last one being a second,
  // independent guard on the "gets a non-empty program from every project it
  // discovered" assertion below.
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
//   `startsWith(root)`          matches `/repo-backup` under root `/repo`
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
// code path.
//
// ⚠️ REQUIRED, deliberately — no default. A `root` that does not contain the
// config makes `repoRelative` reject every file, and the sweep then returns
// empty while reporting success: "this project is clean" and "this sweep saw
// nothing" become the same value. That is the silent-pass direction the parse
// path closes with a throw, and a default parameter is a one-word way back into
// it — today only the assertion shapes at the fixture call sites stand in the
// way, and a negative fixture (`toEqual([])`) would be vacuously green.
//
// ⚠️ Callers pass the root spelled the way the config path was spelled. tsc
// does not canonicalise the paths it derives from a config's own location, so
// `realpathSync`-ing the root while leaving `source.fileName` as tsc spelled it
// makes every `relative()` escape the root and `repoRelative` reject the whole
// program — a silently EMPTY sweep. Measured on macOS, where `mkdtemp` hands
// back `/var/folders/…` for a real `/private/var/folders/…`.
const sweepProject = (configPath: string, root: string) => {
  const { parsed } = readProject(configPath);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const files: string[] = [];
  const optOuts: string[] = [];
  const declarations: string[] = [];
  for (const source of program.getSourceFiles()) {
    const rel = repoRelative(root, source.fileName);
    if (rel === null) {
      continue;
    }
    files.push(rel);
    if ((source as SourceFileWithDirective).checkJsDirective?.enabled === false) {
      optOuts.push(rel);
    }
    if (source.isDeclarationFile) {
      declarations.push(rel);
    }
  }
  return { files: files.sort(), optOuts: optOuts.sort(), declarations: declarations.sort() };
};

type Sweep = ReturnType<typeof sweepProject>;

// Merges results that were ALREADY swept — it does not sweep. Building each
// `ts.Program` costs 150–400 ms, so the describe body sweeps every project
// exactly once into a Map and hands the values here; a `sweepAll(configs)` that
// re-derived them would double that for no gain.
const mergeSweeps = (sweeps: Sweep[]) => ({
  files: new Set(sweeps.flatMap((swept) => swept.files)),
  optOuts: [...new Set(sweeps.flatMap((swept) => swept.optOuts))].sort(),
  declarations: [...new Set(sweeps.flatMap((swept) => swept.declarations))].sort(),
});

// Ask TypeScript instead of reimplementing its scanner.
//
// This guard's question is exactly "does tsc consider this file opted out?", so
// the faithful oracle is tsc itself. Three approximations of tsc's SCANNER were
// tried in this PR and all three were wrong, each one measured only after it
// shipped: a whole-file block-comment strip that swallowed live directives, a
// leading-trivia walk that stopped at a shebang, and a whitespace class that
// missed U+0085 and U+200B. (The tsconfig header counts four misses because it
// also counts the read layer this PR deleted — a different mistake in the same
// shape; the encoding fixtures below are what replaced it.)
// Every fix asserted the next approximation was complete.
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

describe("the directive oracle matches what tsc honours", () => {
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
    // Same idiom as the empty-program assertion below: report the OFFENDERS, so
    // a regression names the fixture instead of printing `expected false to be
    // true` for one of 24 prefixes, several of which are invisible characters.
    expect(honoured.filter((source) => !detectsOptOut(source))).toEqual([]);
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
    expect(notHonoured.filter((source) => detectsOptOut(source))).toEqual([]);
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

describe("the sweep sees a directive through the encodings tsc decodes", () => {
  // These were regressions in this guard's own history: the read layer it used
  // to carry decoded UTF-16 and stripped a UTF-8 BOM by hand, and got there
  // only after shipping a miss on each. Handing the job to a real program is
  // what deleted that layer — so the fixtures move here, one level up, and
  // assert against `sweepProject` rather than against a reader.
  const DIRECTIVE = "// @ts-nocheck\nexport const a: string = 1;\n";

  // Built from char codes, not from any encoder the guard uses, so UTF-16BE is
  // checked against an independent encoding.
  const utf16be = (text: string): Uint8Array => {
    const out = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      out[i * 2] = code >> 8;
      out[i * 2 + 1] = code & 0xff;
    }
    return out;
  };
  // ⚠️ The `new Uint8Array(...)` is NOT a redundant wrapper, and `concat` is not
  // a hand-rolled `Buffer.concat`. Under this repo's @types/node a `Buffer` is a
  // `Uint8Array<ArrayBufferLike>`, which does not assign to the
  // `Uint8Array<ArrayBuffer>` that `writeFileSync` and `utf16be` speak in.
  // Measured: folding either helper into `Buffer.from`/`Buffer.concat` costs
  // four TS2345s under `pnpm compile` — while vitest, being transpile-only,
  // still reports all 22 tests green.
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
    // Under the OS temp dir, never in the work tree: a stray `.ts` in the
    // shared tree is picked up by `tsconfig.json`'s `**/*.ts` and breaks other
    // agents' type-checks.
    root = mkdtempSync(join(tmpdir(), "quoll-nocheck-encoding-"));
    writeFileSync(
      join(root, "tsconfig.json"),
      // `noLib` keeps the fixture programs off the real lib files: they assert
      // containment and directives, never types, and loading lib.d.ts would
      // dominate their runtime.
      JSON.stringify({ compilerOptions: { noEmit: true, noLib: true }, include: ["**/*.ts"] })
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const sweepFixture = () => sweepProject(join(root, "tsconfig.json"), root).optOuts;
  const write = (name: string, bytes: Uint8Array) => writeFileSync(join(root, name), bytes);

  it("strips a UTF-8 BOM, so a shebang still sits at offset 0", () => {
    // The compound case, and the sharpest one: with the BOM left in place `#!`
    // lands at offset 1, where tsc's scanner does not accept it, so everything
    // below stops counting as leading trivia — while tsc, reading the stripped
    // text, honours the directive.
    write(
      "bom-shebang.ts",
      concat(Uint8Array.of(0xef, 0xbb, 0xbf), bytesOf(`#!/usr/bin/env node\n${DIRECTIVE}`, "utf8"))
    );

    expect(sweepFixture()).toEqual(["bom-shebang.ts"]);
    // Pinned as the reason the guard no longer reads files itself: the naive
    // read this deleted disagrees with the program on exactly this file.
    expect(detectsOptOut(readFileSync(join(root, "bom-shebang.ts"), "utf8"))).toBe(false);
  });

  it("decodes UTF-16LE", () => {
    write("utf16le.ts", concat(Uint8Array.of(0xff, 0xfe), bytesOf(DIRECTIVE, "utf16le")));
    expect(sweepFixture()).toEqual(["utf16le.ts"]);
  });

  it("decodes UTF-16BE", () => {
    write("utf16be.ts", concat(Uint8Array.of(0xfe, 0xff), utf16be(DIRECTIVE)));
    expect(sweepFixture()).toEqual(["utf16be.ts"]);
  });

  it("decodes UTF-16BE with a trailing odd byte", () => {
    // tsc truncates the odd tail (`len &= ~1`) and reads the rest. The reader
    // this replaced threw ERR_INVALID_BUFFER_SIZE until it learned to match.
    write(
      "utf16be-odd.ts",
      concat(concat(Uint8Array.of(0xfe, 0xff), utf16be(DIRECTIVE)), Uint8Array.of(0x41))
    );
    expect(sweepFixture()).toEqual(["utf16be-odd.ts"]);
  });

  it("detects a plain UTF-8 file, the no-decoding control", () => {
    write("plain.ts", bytesOf(DIRECTIVE, "utf8"));
    expect(sweepFixture()).toEqual(["plain.ts"]);
  });
});

describe("the sweep follows the program, not a filename pattern", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "quoll-nocheck-sweep-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeProject = (include: string[]) =>
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          noEmit: true,
          noLib: true,
          moduleResolution: "bundler",
          module: "esnext",
        },
        include,
      })
    );

  it("finds a file the include glob never matched, reached only by import", () => {
    // The reason a program is the containment oracle and a glob is not:
    // `test/extension/tsconfig.unit.json` includes four paths, none of which
    // matches `src/extension` or `src/markdown` — the program reaches those only
    // through `types-equality.test.ts`'s imports. A `.mts` pulled in by an
    // explicit specifier is a program input that `**/*.ts` does not match
    // either — the old collector had to guess a wider extension set to cover it.
    writeProject(["entry.ts"]);
    writeFileSync(join(root, "entry.ts"), 'export { helper } from "./helper.mjs";\n');
    writeFileSync(join(root, "helper.mts"), "// @ts-nocheck\nexport const helper = 1;\n");

    const swept = sweepProject(join(root, "tsconfig.json"), root);
    expect(swept.files).toEqual(["entry.ts", "helper.mts"]);
    expect(swept.optOuts).toEqual(["helper.mts"]);
  });

  it("throws on a config it cannot resolve, instead of sweeping it as empty", () => {
    // The silent-pass direction, closed. A config that stops parsing must not
    // read as "this project contributed no files", which is indistinguishable
    // from "this project is clean".
    //
    // Measured on TS 5.9.3 — every one of these surfaces through
    // `getConfigFileParsingDiagnostics` and therefore throws: truncated JSON
    // (TS1005), garbage JSON (TS1005/TS1327/TS1328/TS1136), self-circular
    // `extends` (TS18000), a missing `extends` target (TS5083), an unknown
    // compiler option (TS5023), and an `include` that matches nothing (TS18003).
    // The last is a second, independent guard on the "gets a non-empty program
    // from every project it discovered" assertion below.
    //
    // This is also what replaces `getParsedCommandLineOfConfigFile`'s
    // `onUnRecoverableConfigFileDiagnostic` hook. That hook's job — do not let
    // an unusable config look usable — is now split in two: the read check in
    // `readProject` covers a config that cannot be read at all, and this
    // diagnostic set covers one that can be read but not understood.
    for (const [label, contents] of [
      // ⚠️ The first case is the one that matters most, and it is the one an
      // earlier draft missed: a config truncated mid-object puts TS1005 on the
      // SOURCE FILE and leaves `parsed.errors` empty, so a `parsed.errors`-only
      // check reported a clean project with a partial file list. Keep it first
      // so a future edit that narrows the diagnostic source goes red here.
      ["truncated JSON", '{"include":["**/*.ts"],'],
      ["garbage JSON", "{ this is not json"],
      [
        "self-circular extends",
        JSON.stringify({ extends: "./tsconfig.json", include: ["**/*.ts"] }),
      ],
      ["missing extends target", JSON.stringify({ extends: "./nope.json", include: ["**/*.ts"] })],
      [
        "unknown option",
        JSON.stringify({ compilerOptions: { bogusOption: true }, include: ["**/*.ts"] }),
      ],
      ["include matches nothing", JSON.stringify({ include: [] })],
    ] as const) {
      writeFileSync(join(root, "tsconfig.json"), contents);
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");

      expect(() => sweepProject(join(root, "tsconfig.json"), root), label).toThrow();
    }

    // The read branch, pinned separately and by MESSAGE, not just by throwing.
    // Without this the branch could be deleted and the suite would stay green:
    // the raw `TypeError: Cannot read properties of undefined (reading '0')`
    // that `parseJsonSourceFileConfigFileContent` produces on an unread config
    // also satisfies a bare `toThrow()`. What is worth keeping is not "it
    // fails" — it is "it fails saying which file", since the whole point of the
    // branch is that the old failure named nothing.
    expect(() => sweepProject(join(root, "missing-tsconfig.json"), root)).toThrow(
      /could not be read/
    );
  });

  it("flags an opt-out that hides in a subdirectory", () => {
    writeProject(["**/*.ts"]);
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "sneaky.ts"), "// @ts-nocheck\nexport const a = 1;\n");

    expect(sweepProject(join(root, "tsconfig.json"), root).optOuts).toEqual([
      join("nested", "sneaky.ts"),
    ]);
  });

  it("reports declaration files, including the arbitrary-extension form", () => {
    // `isDeclarationFile` on the program's own SourceFile is the oracle, so the
    // name variants come free.
    writeProject(["**/*.ts"]);
    writeFileSync(join(root, "types.d.ts"), "export declare const a: string;\n");
    writeFileSync(join(root, "types.d.css.ts"), "export declare const b: string;\n");
    writeFileSync(join(root, "value.ts"), "export const c = 1;\n");

    expect(sweepProject(join(root, "tsconfig.json"), root).declarations).toEqual([
      "types.d.css.ts",
      "types.d.ts",
    ]);
  });

  it("shows why declarations are reported at all: skipLibCheck stops checking them", () => {
    // The reason the arm above exists, PROVEN rather than asserted in a comment.
    //
    // An earlier draft named `skipLibCheck` in the test title while the fixture
    // never set it — so the test demonstrated file classification and nothing
    // about checking, and the title claimed the part it did not measure. That is
    // the same "prose asserts coverage the code lacks" defect this file has
    // already shipped three times; here it is spent one round earlier, in
    // review.
    //
    // Measured on TS 5.9.3: the planted error in the `.d.ts` is reported as
    // three diagnostics with `skipLibCheck: false` and zero with it on. So in
    // this repo — where `tsconfig.base.json` sets `skipLibCheck: true` — a
    // declaration file is unchecked with no directive at all, which no
    // improvement to the directive detector could ever catch.
    const diagnosticsWith = (skipLibCheck: boolean) => {
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { noEmit: true, noLib: true, skipLibCheck },
          include: ["**/*.ts"],
        })
      );
      const { parsed } = readProject(join(root, "tsconfig.json"));
      return ts
        .createProgram({ rootNames: parsed.fileNames, options: parsed.options })
        .getSemanticDiagnostics()
        .map((d) => d.code);
    };
    writeFileSync(
      join(root, "broken.d.ts"),
      "export declare const a: string;\nconst bad: string = 1;\n"
    );

    expect(diagnosticsWith(false)).not.toEqual([]);
    expect(diagnosticsWith(true)).toEqual([]);
  });
});

// Discovered once. The roster below, the `pnpm compile` cross-check and the
// sweep are asserted against EACH OTHER, so they have to be talking about one
// set — three independent calls left that relationship implicit and invited a
// reader to wonder whether the three could disagree.
const PROJECTS = discoverProjects(REPO_ROOT);

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
    // one-line edit per new tsc program — seven of them so far, plus the
    // options base discovery leaves out.)
    expect(PROJECTS.map((p) => relative(REPO_ROOT, p))).toEqual([
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
    const scripts = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"))
      .scripts as Record<string, string>;
    const referenced = [
      ...`${scripts.compile} && ${scripts["compile:webview"]}`.matchAll(/tsc -p (\S+)/g),
    ].map(([, target]) => resolveCliProjectTarget(join(REPO_ROOT, target)));

    // 5 from `compile`, 1 from `compile:webview` — pinned so a script edit that
    // drops a `tsc -p` invocation cannot quietly shrink what this test checks.
    expect(referenced.length).toBe(6);
    const discovered = new Set(PROJECTS);
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

  it("does not walk into dot-directories, where tsc's `**` never goes", () => {
    // Reproduced before this guard existed: a `/review-cycle` reviewer's probe
    // tsconfig under `.review-cycle-<id>/scratch/` joined the roster, and one
    // that did not parse took collection down for the whole file. The planted
    // directive below is the second half of the same failure — a stray project
    // is also SWEPT, so its files reach `optOuts` on a project no `tsc -p` in
    // this repo ever names.
    const root = mkdtempSync(join(tmpdir(), "quoll-nocheck-dotdir-"));
    try {
      const project = JSON.stringify({
        compilerOptions: { noEmit: true, noLib: true },
        include: ["*.ts"],
      });
      writeFileSync(join(root, "tsconfig.json"), project);
      writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
      mkdirSync(join(root, ".scratch"));
      writeFileSync(join(root, ".scratch", "tsconfig.json"), project);
      writeFileSync(join(root, ".scratch", "b.ts"), "// @ts-nocheck\nexport const b = 1;\n");

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
  // `ts.Program`, ~150–400 ms; re-deriving per `it` would build all seven once
  // per assertion — four times over. (b) Flake: vitest's default `testTimeout`
  // is 5000 ms and this repo
  // deliberately runs uncapped parallel workers (see vitest.config.ts's note on
  // the ruled-out load-flake), so a multi-second body inside an `it` is exactly
  // the shape that goes intermittently red under contention. Collection-time
  // work carries no per-test timeout.
  const perProject = new Map(
    PROJECTS.map((p) => [relative(REPO_ROOT, p), sweepProject(p, REPO_ROOT)])
  );
  const swept = mergeSweeps([...perProject.values()]);

  it("reaches the whole repo, not one directory (guards a vacuous sweep)", () => {
    // Per-project floors, not only a union floor. `test/webview` contributes
    // 323 of the 467 files measured when this landed, so a union floor of 300
    // is satisfiable by ONE program while every other one shrinks to its anchor
    // plus transitive imports — and a file dropped out of every program is
    // exactly as unchecked as one carrying a directive, with no text in it to
    // notice. Each floor is roughly half its measured count, so routine churn
    // never touches this list while a program losing most of its `include` goes
    // red naming itself. A project missing from the table falls back to
    // "non-empty"; the roster assertion above is what makes a new one visible.
    const floors: Record<string, number> = {
      "src/webview/tsconfig.json": 80,
      "test/build/tsconfig.json": 12,
      "test/extension/tsconfig.json": 25,
      "test/extension/tsconfig.unit.json": 7,
      "test/webview-browser/tsconfig.json": 90,
      "test/webview/tsconfig.json": 160,
      "tsconfig.json": 45,
    };
    const undersized = [...perProject]
      .filter(([configPath, project]) => project.files.length < (floors[configPath] ?? 1))
      .map(([configPath, project]) => `${configPath}: ${project.files.length}`);

    expect(undersized).toEqual([]);
    // A floor on the union too, not an exact count — it was 467 files when this
    // landed and moves with every source file added. What it pins is that the
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
    const empty = [...perProject]
      .filter(([, project]) => project.files.length === 0)
      .map(([configPath]) => configPath);

    expect(empty).toEqual([]);
  });
});
