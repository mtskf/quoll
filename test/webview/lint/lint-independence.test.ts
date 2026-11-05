import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../../"); // test/webview/lint -> repo root

const LINT_SOURCE_FILES = [
  "src/webview/cm/lint/types.ts",
  "src/webview/cm/lint/engine.ts",
  "src/webview/cm/lint/line-scan.ts",
  "src/webview/cm/lint/rules/index.ts",
  "src/webview/cm/lint/rules/heading-increment.ts",
  "src/webview/cm/lint/rules/no-trailing-spaces.ts",
  "src/webview/cm/lint/rules/no-multiple-blanks.ts",
  "src/webview/cm/lint/rules/duplicate-heading-text.ts",
  "src/webview/cm/lint/rules/table-column-count.ts",
  "src/webview/cm/lint/rules/frontmatter-structure.ts",
  "src/webview/cm/lint/extension.ts",
  "src/webview/cm/lint/index.ts",
];

const HOST_MODULE = /src\/extension\//;
function importsHost(rel: string, mod: string): boolean {
  const resolved = mod.startsWith(".")
    ? path
        .resolve(path.dirname(path.join(ROOT, rel)), mod)
        .split(path.sep)
        .join("/")
    : mod;
  return HOST_MODULE.test(resolved);
}
// Matchers mirror test/markdown/no-pm-import.test.ts so the full surface is
// covered: IMPORT_FROM's `[^;'"]` spans newlines (catches multiline imports),
// plus dedicated side-effect, re-export, and dynamic-import forms.
const IMPORT_FROM = /^\s*import\s+(?:type\s+)?(?:[^;'"]+?\s+from\s+)?["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;
const REEXPORT_FROM = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function importedModules(src: string): string[] {
  const mods: string[] = [];
  for (const re of [IMPORT_FROM, SIDE_EFFECT_IMPORT, REEXPORT_FROM, DYNAMIC_IMPORT]) {
    for (const m of src.matchAll(re)) {
      mods.push(m[1]!);
    }
  }
  return mods;
}

describe("lint layer is independent of the host", () => {
  it.each(LINT_SOURCE_FILES)("%s imports nothing from the host", (rel) => {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    for (const mod of importedModules(src)) {
      expect(importsHost(rel, mod)).toBe(false);
    }
  });

  it("detects a relative import of host edit decisions", () => {
    expect(
      importsHost("src/webview/cm/lint/engine.ts", "../../../extension/session/edit-decision.js")
    ).toBe(true);
  });
});
