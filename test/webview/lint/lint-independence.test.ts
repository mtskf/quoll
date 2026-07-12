import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateMarkdownForWrite } from "../../../src/markdown/validate-for-write.js";
import { lintMarkdown } from "../../../src/webview/cm/lint/engine.js";

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

// The write-gate modules the lint layer must NEVER import: lint is advisory and
// must stay structurally independent of the disk-write validator.
const WRITE_GATE = /validate-for-write|lezer-url-walker|url-allowlist/;
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

describe("lint layer is independent of the write gate", () => {
  it.each(LINT_SOURCE_FILES)("%s imports nothing from the write gate", (rel) => {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    for (const mod of importedModules(src)) {
      expect(WRITE_GATE.test(mod)).toBe(false);
    }
  });

  it("a lint-dirty but write-safe document still passes the write gate", () => {
    // Heading skip + trailing space: at least two lint warnings, zero write-gate
    // concerns (no unsafe URL, no broken frontmatter).
    const doc = "# Title \n\n### Skip\n";
    expect(lintMarkdown(doc).length).toBeGreaterThanOrEqual(2);
    expect(validateMarkdownForWrite(doc)).toEqual({ ok: true });
  });
});
