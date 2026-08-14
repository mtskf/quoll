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
  if (ts.isIdentifier(target)) {
    return target.text;
  }
  return "";
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
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && BANNED.has(calleeName(node))) {
          const name = calleeName(node);
          const exempt = name === "tmpdir" && TMPDIR_REFERENCE_ALLOWED.has(file);
          if (!exempt) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            offenders.push(`${path.relative(SCAN_ROOT, file)}:${line + 1} ${name}()`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(
      offenders,
      "use makeTempDir/makeTempDirSync from ./harness — temp-root.ts is the only allocation site"
    ).toEqual([]);
  });
});
