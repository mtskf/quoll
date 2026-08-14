import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Default-deny: a suite that allocates straight from os.tmpdir() strands
// that dir forever — 2 544 accumulated, +53 per run, measured 2026-08-14.
// The only sanctioned allocation is temp-root.ts, whose dirs live under the
// per-run root that launch.ts disposes on exit.
//
// AST, not regex: a source-text scan trips on the word `mkdtemp` inside a
// comment or a string (this very file would trip it) and cannot tell a call
// from a mention.
const SCAN_ROOT = path.resolve(__dirname);
const BANNED = new Set(["mkdtemp", "mkdtempSync", "tmpdir"]);

// The seam itself allocates — that is its job.
const ALLOCATION_SITE = path.join(SCAN_ROOT, "temp-root.ts");
// The seam's test may NAME os.tmpdir() to pin where the root lands, but it
// still may not allocate: `mkdtemp*` stays banned there.
const TMPDIR_REFERENCE_ALLOWED = new Set([path.join(SCAN_ROOT, "temp-root.test.ts")]);

function collectSources(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "fixtures") {
        continue;
      }
      collectSources(full, acc);
    } else if (entry.name.endsWith(".ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function calleeName(node: ts.CallExpression): string {
  const target = node.expression;
  if (ts.isPropertyAccessExpression(target)) {
    return target.name.text;
  }
  // fs["mkdtempSync"](…) — an element access is still a call to the same thing.
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return target.argumentExpression.text;
  }
  if (ts.isIdentifier(target)) {
    return target.text;
  }
  return "";
}

/** BANNED plus whatever local names those symbols were imported AS — without
 *  this, `import { mkdtemp as mkTmp }` walks straight past the guard, and that
 *  rename is something an import-organiser can introduce mechanically. */
function bannedNamesIn(source: ts.SourceFile): Set<string> {
  const names = new Set(BANNED);
  source.forEachChild((node) => {
    if (!ts.isImportDeclaration(node)) {
      return;
    }
    const named = node.importClause?.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const spec of named.elements) {
        if (BANNED.has((spec.propertyName ?? spec.name).text)) {
          names.add(spec.name.text);
        }
      }
    }
  });
  return names;
}

function findOffenders(source: ts.SourceFile, label: string): string[] {
  const banned = bannedNamesIn(source);
  const offenders: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && banned.has(calleeName(node))) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      offenders.push(`${label}:${line + 1} ${calleeName(node)}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offenders;
}

describe("e2e temp-dir choke point", () => {
  const sources = collectSources(SCAN_ROOT).filter((file) => file !== ALLOCATION_SITE);

  it("scans the whole test/extension tree", () => {
    // Without this, a moved directory would make the scan below vacuously
    // pass over an empty file list.
    expect(sources.length).toBeGreaterThan(25);
    expect(sources.some((f) => f.endsWith(path.join("e2e", "harness.ts")))).toBe(true);
    expect(sources.some((f) => f.endsWith("launch.ts"))).toBe(true);
  });

  it("finds no temp-dir allocation outside temp-root.ts", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const source = ts.createSourceFile(
        file,
        fs.readFileSync(file, "utf8"),
        ts.ScriptTarget.ES2022,
        true
      );
      const found = findOffenders(source, path.relative(SCAN_ROOT, file));
      // The seam's own test may NAME os.tmpdir() to pin where the root lands;
      // it still may not allocate, so only `tmpdir` is exempted there.
      offenders.push(
        ...(TMPDIR_REFERENCE_ALLOWED.has(file)
          ? found.filter((entry) => !entry.endsWith("tmpdir()"))
          : found)
      );
    }
    expect(
      offenders,
      "use makeTempDir/makeTempDirSync from ./harness — temp-root.ts is the only allocation site"
    ).toEqual([]);
  });

  it("catches the bypasses a rename or an indexed call would open", () => {
    // Exercises the branches above, which no real source file currently hits —
    // without this they would be dead code that silently stops working.
    const probe = ts.createSourceFile(
      "probe.ts",
      [
        'import { mkdtemp as mkTmp } from "node:fs/promises";',
        'import * as os from "node:os";',
        'await mkTmp(os.tmpdir() + "/x-");',
        'fs["mkdtempSync"]("/tmp/y-");',
      ].join("\n"),
      ts.ScriptTarget.ES2022,
      true
    );
    expect(findOffenders(probe, "probe.ts")).toEqual([
      "probe.ts:3 mkTmp()",
      "probe.ts:3 tmpdir()",
      "probe.ts:4 mkdtempSync()",
    ]);

    // Banning `tmpdir` is what stops a hand-rolled
    // `fs.mkdirSync(path.join(os.tmpdir(), …))` — `mkdirSync` is deliberately
    // not in BANNED — so the exemption must stay scoped to the seam's own
    // test. Widening it tree-wide is otherwise a green edit.
    const tmpdirProbe = ts.createSourceFile(
      "probe.ts",
      'import * as os from "node:os";\nfs.mkdirSync(os.tmpdir() + "/x");',
      ts.ScriptTarget.ES2022,
      true
    );
    expect(findOffenders(tmpdirProbe, "probe.ts")).toEqual(["probe.ts:2 tmpdir()"]);
    expect([...TMPDIR_REFERENCE_ALLOWED]).toEqual([path.join(SCAN_ROOT, "temp-root.test.ts")]);
  });
});
