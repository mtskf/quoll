// C2 acceptance: the write-gate (validate-for-write.ts +
// lezer-url-walker.ts + url-allowlist.ts) has ZERO prosemirror-*
// runtime imports and only imports from a declared allow-list.
// Type-only imports of MarkdownError from errors.ts are fine —
// runtime is what the gate's framework-independence promises.
//
// Inspection scope: import-from statements + side-effect imports +
// re-exports. Dynamic `import("x")` is NOT scanned by this file; a
// regression introducing one would need code review to land, and the
// human reviewer is the backstop for that vector.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../"); // test/markdown -> repo root

function readSource(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

// Match every import-from-something statement (runtime OR type), then
// filter at the test site. Covers:
//   - `import x from "y"` (default)
//   - `import { x } from "y"` (named)
//   - `import * as x from "y"` (namespace)
//   - `import type { x } from "y"` (top-level type-only — m[1] populated)
//   - `import "y"` (side-effect - captured by the side-effect regex below)
// Re-exports `export ... from "y"` are matched by the re-export regex.
// Dynamic `import("x")` is out of scope (see file comment).
const IMPORT_FROM = /^\s*import\s+(type\s+)?(?:[^;'"]+?\s+from\s+)?["']([^"']+)["']/gm;
// TS 4.5+ inline-modifier form: `import { type A, type B } from "y"`.
// ALL bindings must carry the `type` modifier for the import to be
// type-only at the runtime level — a single non-type binding makes the
// whole statement runtime. The regex demands a `{ ... }` whose every
// comma-separated entry begins with `type `.
const INLINE_TYPE_ALL =
  /^\s*import\s+\{\s*(?:type\s+[A-Za-z_$][\w$]*\s*,?\s*)+\}\s+from\s+["']([^"']+)["']/gm;
const SIDE_EFFECT_IMPORT = /^\s*import\s+["']([^"']+)["']/gm;
const REEXPORT_FROM = /^\s*export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/gm;

// Collect per-module isType verdicts. INLINE_TYPE_ALL runs FIRST and
// pre-seeds the set of modules whose `import { type ... }` form is
// fully type-erased; the IMPORT_FROM pass would otherwise classify
// those statements as runtime (its `(type\s+)?` capture only catches
// the top-level `import type` form, not the inline modifier).
// Side-effect imports and re-exports always emit runtime code.
function listImports(source: string): { module: string; isType: boolean }[] {
  const inlineTypeOnly = new Set<string>();
  for (const m of source.matchAll(INLINE_TYPE_ALL)) {
    inlineTypeOnly.add(m[1]);
  }
  const out: { module: string; isType: boolean }[] = [];
  for (const m of source.matchAll(IMPORT_FROM)) {
    const mod = m[2];
    const isType = m[1] !== undefined || inlineTypeOnly.has(mod);
    out.push({ module: mod, isType });
  }
  for (const m of source.matchAll(SIDE_EFFECT_IMPORT)) {
    out.push({ module: m[1], isType: false });
  }
  for (const m of source.matchAll(REEXPORT_FROM)) {
    out.push({ module: m[1], isType: false });
  }
  return out;
}

const GATE_FILES = [
  "src/markdown/validate-for-write.ts",
  "src/markdown/lezer-url-walker.ts",
  "src/markdown/url-allowlist.ts",
];

// SCOPE NOTE: this test covers IMPORT STATEMENTS at the source level —
// top-level `import` / `import type` / `import "x"` (side-effect) /
// `export ... from "x"` (re-export). It is NOT a complete static
// reachability proof. The following vectors are KNOWN gaps and are
// documented here so the suite's claim doesn't oversell:
//   - Dynamic `import("prosemirror-...")` — not scanned (regex can't
//     express runtime import expressions). Human review is the
//     backstop; a PR that adds a runtime `import()` of a PM module is
//     flagged by code review, not by this test.
//   - Transitive runtime deps through an allow-listed module (e.g. if
//     `./url-allowlist.js` someday imported a PM module, this test
//     would still pass because we only inspect the gate files' own
//     imports). The per-file allow-lists narrow blast radius but do
//     not prove reachability.
//   - Source-level "no `prosemirror` substring in the file" is
//     deliberately NOT enforced — the impl files mention "ProseMirror"
//     in migration-context comments. We pin imports, not free text.
describe("C2 write-gate has no ProseMirror runtime imports declared in its own files", () => {
  it.each(GATE_FILES)("%s has no prosemirror-* import statement", (rel) => {
    const src = readSource(rel);
    for (const { module } of listImports(src)) {
      expect(module.startsWith("prosemirror-")).toBe(false);
    }
  });

  it.each(GATE_FILES)("%s does not import from the doomed schema.ts", (rel) => {
    const src = readSource(rel);
    expect(src).not.toMatch(/from\s+["'][^"']*editor\/schema(?:\.js)?["']/);
  });

  it("validate-for-write.ts runtime imports are inside the framework-agnostic allow-list", () => {
    // Allow-listed runtime deps. errors.ts is currently type-only; if
    // a future change adds a runtime errors.js import, extend this
    // list deliberately.
    // ../shared/perf.js: the dev-only perf aggregator (zero-dep,
    // framework-agnostic, dead-code-eliminated in production via the
    // QUOLL_PERF build flag). It imports nothing, so allow-listing it
    // drags in no framework transitively — the gate stays PM-free.
    const ALLOW = new Set(["./frontmatter.js", "./lezer-url-walker.js", "../shared/perf.js"]);
    const imports = listImports(readSource("src/markdown/validate-for-write.ts"));
    for (const { module, isType } of imports) {
      if (isType) {
        continue; // type-only imports are ignored — they emit no runtime code
      }
      expect(ALLOW.has(module)).toBe(true);
    }
  });

  it("lezer-url-walker.ts runtime imports stay inside the lezer + allowlist allow-list", () => {
    // ./url-decode.js was added by Slice C4b Task 3: the pure decoder
    // helpers were extracted to that module so the webview's
    // click-to-open handler can decode without dragging the host-side
    // Lezer parser into the webview bundle. lezer-url-walker.ts
    // re-imports + re-exports decodeMarkdownDestination to keep the
    // historic import path green.
    const ALLOW = new Set(["@lezer/markdown", "./url-allowlist.js", "./url-decode.js"]);
    const imports = listImports(readSource("src/markdown/lezer-url-walker.ts"));
    for (const { module, isType } of imports) {
      if (isType) {
        continue;
      }
      expect(ALLOW.has(module)).toBe(true);
    }
  });

  it("url-allowlist.ts has no runtime imports (framework-agnostic primitive)", () => {
    const imports = listImports(readSource("src/markdown/url-allowlist.ts"));
    for (const { isType } of imports) {
      expect(isType).toBe(true); // any import here must be type-only
    }
  });

  // TS 4.5+ inline-modifier form pin. `import { type X } from "y"` emits
  // no runtime code (each binding is type-erased), so this test must
  // classify it as type-only. Before INLINE_TYPE_ALL was added, the
  // single regex captured the statement with m[1] === undefined and
  // classified it as RUNTIME — a stylistic refactor (Biome's
  // `useImportType` autofix or a contributor's autoformat) toward the
  // inline form would have caused a false-positive failure on legitimate
  // type-only imports of a PM module from outside the gate.
  it('treats inline `import { type X } from "y"` as type-only', () => {
    const fake = `import { type Foo } from "prosemirror-model";\n`;
    const imports = listImports(fake);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({ module: "prosemirror-model", isType: true });
  });

  it('treats inline `import { type A, type B } from "y"` (all-type, multi-binding) as type-only', () => {
    const fake = `import { type Foo, type Bar } from "prosemirror-model";\n`;
    const imports = listImports(fake);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({ module: "prosemirror-model", isType: true });
  });

  it('treats inline `import { type A, B } from "y"` (MIXED type+runtime) as RUNTIME', () => {
    // Mixed bindings emit runtime code for the non-type binding, so
    // INLINE_TYPE_ALL must NOT match (its all-types-prefixed
    // `(?:type\s+...)+` requirement fails on the bare `B`). The fallback
    // IMPORT_FROM match then classifies the statement as runtime.
    const fake = `import { type Foo, Bar } from "prosemirror-model";\n`;
    const imports = listImports(fake);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toEqual({ module: "prosemirror-model", isType: false });
  });
});

describe("C9b cutover: no ProseMirror / mdast / micromark / React in the shipped tree", () => {
  it("no dependency section declares a prosemirror/mdast/micromark/react package", () => {
    const pkg = JSON.parse(readSource("package.json")) as Record<string, unknown>;
    const SECTIONS = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ];
    const BANNED =
      /^(?:prosemirror(?:-|$)|mdast(?:-|$)|micromark(?:-|$)|react(?:-|$)|@types\/(?:react|mdast)(?:-|$))/;
    const offenders: string[] = [];
    for (const section of SECTIONS) {
      const deps = pkg[section];
      if (deps && typeof deps === "object") {
        for (const name of Object.keys(deps as Record<string, string>)) {
          if (BANNED.test(name)) {
            offenders.push(`${section}:${name}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
