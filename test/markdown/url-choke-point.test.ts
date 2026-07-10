// Cross-cutting structural guard for the URL/security choke points.
// (Lives in test/markdown/ alongside its sibling structural guard
// no-pm-import.test.ts because src/markdown/url-allowlist.ts is the
// single source of truth for URL safety — though this scan covers ALL
// of src/**, host + webview included.)
//
// WHY: isAllowedUrl / renderSafeUrl (the render-gate) and
// handle-open-external.ts (the host open-external gate) are the URL
// security choke points. Nothing structurally stops a future file from
// minting a `new URL(...)`, writing a raw `.href`/`.src` DOM attribute,
// calling `setAttribute("href"|"src", …)`, or invoking the host
// `env.openExternal()` directly — any of which would bypass the gate.
// This guard fails CI if a URL-bearing primitive appears OUTSIDE the
// per-primitive allowlist below.
//
// ALLOWLIST IS PER-PRIMITIVE, NOT PER-FILE, AND DEFAULT-DENY: each primitive
// lists exactly the files where it is a legitimate choke point. A file
// allowlisted for `openExternal` is still flagged if it grows a raw
// `.href =` — the permission's blast radius stays minimal. The allow sets
// are kept LIVE-ONLY: a primitive that appears nowhere in `src/**` carries
// an EMPTY allow set (default-deny), and the liveness test below fails if an
// allow entry ever points at a file that no longer uses its primitive.
// To legitimately introduce one of the currently-empty primitives, the
// introducing change must add its file to the allow set in the SAME reviewed
// commit — that explicit edit IS the intended choke-point workflow.
//
// DEVIATION FROM THE ORIGINATING TODO: the TODO sketched a four-file
// allowlist incl. "the webview render-gate helper". Reality has no single
// render-gate helper — the live DOM writes are `.href`/`.src` PROPERTY
// assignments in two widget files (cell-render.ts, image-widget.ts), the
// `env.openExternal` binding lives in quoll-editor-panel.ts (plus the host
// gate handle-open-external.ts), and validate-for-write.ts contains none of
// these primitives (it gates via isAllowedUrl). One primitive remains
// unused anywhere in `src/**` and so carries an empty allow set:
//   - `setAttribute("href"|"src")`: the widgets write `.href`/`.src` as
//     properties, never via setAttribute.
// `new URL(` is now a live choke point (relative-image read path): two files
// are allowlisted — url-allowlist.ts (the URL-safety source of truth) and
// resource-base.ts (resolves relative refs before handing them to the gate).
// The lists below are reconciled to the real tree.
//
// SCOPE / KNOWN GAPS (so this guard does not oversell):
//   - It scans source TEXT (comment-stripped), not a typed AST. Aliased
//     calls (`const f = env.openExternal; f(u)`), computed property writes
//     (`el["hr"+"ef"] = u`), and dynamic attribute names are NOT caught.
//     Human review is the backstop for those vectors.
//   - Comment stripping is regex-based, not a tokenizer: a `//` or `/*`
//     inside a string/regex literal is mistaken for a comment, so the
//     stripper blanks from that marker to end-of-line (`//`) or to the
//     next `*/` (`/*`). This CAN erase a real primitive that follows the
//     literal on the same line (or, for `/*`, on later lines) — i.e. an
//     un-gated call can be missed. No `src/**` file triggers this today
//     (all `//`/`/*` occurrences sit in comments); a future literal
//     containing a comment marker ahead of a primitive would slip past.
//     Keep URL-bearing writes on their own line; human review is the
//     backstop. (Stripping only removes bytes, never adds — so this class
//     cannot cause a FALSE positive.)
//   - Multi-line / optional-chaining call syntax is undetected: the scanner
//     splits on `\n` and tests each line in isolation, so a call split
//     across lines (`new\nURL(x)`, `anchor.href\n= x`, `env.openExternal\n(x)`)
//     evades it; likewise `env.openExternal?.(x)` (the `?.` token is not in
//     the `/\.openExternal\s*\(/` pattern). Syntactically legal but unusual —
//     human review is the backstop.
//   - Literal CONTENTS are not stripped, so a string/template/regex literal
//     that spells a primitive (`const s = "new URL(";`, `const s = ".href =";`,
//     `` const s = `x.setAttribute("href", y)`; ``, `const s = "x.openExternal(";`)
//     false-positives. There is also no receiver-type guard: `.href`/`.src`/
//     `setAttribute` flag on any receiver, so `obj.src = x` on a non-DOM
//     object would trip. The tree is clean today; suppress with a per-line
//     comment marker if a benign literal ever trips it.
//   - Allowlisting is PER-FILE, not per-callsite (see ALLOWLIST note above):
//     once a file is allowlisted for a primitive, ANY number of additional
//     uses of THAT primitive in THAT file are permitted. The guard pins
//     "which files", not "how many times". Cross-primitive enforcement is
//     still tight (a `.href`-allowlisted file is caught for `openExternal`).
//     Per-callsite enforcement would need a typed AST.
//   - "ad-hoc scheme regex" (mentioned in the TODO prose) is intentionally
//     NOT detected — it is not reliably expressible as a primitive regex.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../"); // test/markdown -> repo root
const SRC = path.join(ROOT, "src");

// --- choke-point definitions ------------------------------------------------

type ChokePoint = {
  /** Stable name used in failure messages and the non-vacuity assertion. */
  readonly name: string;
  /** Matches the primitive on a single (comment-stripped) line. Non-global:
   *  we only need a per-line boolean, which sidesteps lastIndex statefulness. */
  readonly pattern: RegExp;
  /** Repo-relative POSIX paths where this primitive is a legitimate gate. */
  readonly allow: ReadonlySet<string>;
};

const RENDER_ENDPOINTS = [
  "src/webview/cm/table/cell-render.ts",
  "src/webview/cm/image/image-widget.ts",
] as const;

// Files that legitimately construct `new URL(...)` as part of the URL-safety
// gate (as opposed to raw URL minting that would bypass the gate):
//   - url-allowlist.ts: the URL-safety source of truth; `resolveTrustedResourceUrl`
//     parses base + resolves relative refs with `new URL`, then enforces a
//     protocol+host equality check before minting an `AllowlistedUrl` — the
//     parse IS the gate.
//   - resource-base.ts: `resolveAgainstBase` calls `new URL(url)` only to
//     classify an already-`renderSafeUrl`-gated destination as absolute-vs-
//     relative; relative refs then go through `resolveTrustedResourceUrl`.
//     It parses nothing it hasn't already gated.
// Any OTHER file minting a raw URL is still flagged (default-deny). The
// liveness test below flags a stale entry if either file no longer uses the
// primitive.
// Smart-paste HTML→GFM converter (html-table-to-gfm.ts) parses a `text/html`
// clipboard fragment with DOMParser to read table structure. It is a legitimate
// choke-point exception BECAUSE it reads cell TEXT ONLY (`textContent`) — every
// `href`/`src` in the parsed DOM is dropped, so no URL from the parsed tree ever
// reaches the render- or write-gate as a live URL. The parse extracts structure,
// never a URL.
const HTML_TABLE_PASTE_PARSE = ["src/webview/cm/paste/html-table-to-gfm.ts"] as const;

const URL_PARSE_ENDPOINTS = [
  "src/markdown/url-allowlist.ts",
  "src/webview/cm/image/resource-base.ts",
] as const;

const CHOKE_POINTS: readonly ChokePoint[] = [
  {
    name: "new URL(",
    pattern: /\bnew\s+URL\s*\(/,
    allow: new Set(URL_PARSE_ENDPOINTS),
  },
  {
    // `=(?!=)` excludes ==, ===, !== comparisons; `\s*` after .href/.src
    // tolerates `a.href = x`. `.srcset`/`.source` do not match (the char
    // after `src` is not `=` or whitespace-then-`=`).
    name: ".href / .src assignment",
    pattern: /\.(?:href|src)\s*=(?!=)/,
    allow: new Set(RENDER_ENDPOINTS),
  },
  {
    // No production file uses `setAttribute("href"|"src", …)` today — the two
    // render endpoints write `.href`/`.src` directly (see the entry above),
    // not via setAttribute. Empty allow set: any future setAttribute on a URL
    // attribute must be reviewed in. (Was RENDER_ENDPOINTS, but that was a
    // dead entry — neither endpoint calls setAttribute for href/src:
    // cell-render.ts uses none, image-widget.ts only for role/aria-label.
    // The liveness test below now enforces this.)
    name: 'setAttribute("href"|"src")',
    pattern: /setAttribute\(\s*["'](?:href|src)["']/,
    allow: new Set<string>(),
  },
  {
    name: "host env.openExternal()",
    pattern: /\.openExternal\s*\(/,
    // handle-open-external.ts is the host gate; quoll-editor-panel.ts holds the
    // real `env.openExternal` binding. effect-executor.ts invokes the injected
    // open-external delegate via a local alias (`runOpenExternal`), NOT
    // `deps.openExternal(...)`, so it does not textually match this pattern and
    // is intentionally kept OUT of this allowlist — a future raw
    // `env.openExternal(...)` added there would still be flagged.
    allow: new Set([
      "src/extension/handle-open-external.ts",
      "src/extension/quoll-editor-panel.ts",
    ]),
  },
  {
    // Live-DOM-from-string promotion. Quoll builds ALL DOM via
    // createElement + textContent (no innerHTML anywhere in src/**), which is
    // what keeps raw HTML in a document inert source text and never a live
    // DOM subtree. Empty allow set (default-deny): any future widget that
    // wants string→DOM injection must be reviewed in here AND carry its own
    // sanitizer + threat model (see C2 security note — no HTML-preview widget).
    // `=(?!=)` excludes == / === comparisons, matching the .href/.src style.
    name: ".innerHTML / .outerHTML assignment",
    pattern: /\.(?:inner|outer)HTML\s*=(?!=)/,
    allow: new Set<string>(),
  },
  {
    name: "insertAdjacentHTML(",
    pattern: /\.insertAdjacentHTML\s*\(/,
    allow: new Set<string>(),
  },
  {
    name: "document.write(",
    pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/,
    allow: new Set<string>(),
  },
  {
    // string→DOM via the HTML parser — construction.
    name: "new DOMParser(",
    pattern: /\bnew\s+DOMParser\s*\(/,
    allow: new Set(HTML_TABLE_PASTE_PARSE),
  },
  {
    // The actual dangerous DOMParser op (Codex review #6): catches
    // `parser.parseFromString(html, ...)` regardless of how/where the parser
    // was constructed (module import, globalThis, aliased).
    name: "parseFromString(",
    pattern: /\.parseFromString\s*\(/,
    allow: new Set(HTML_TABLE_PASTE_PARSE),
  },
  {
    // Range.createContextualFragment(str) parses HTML into a fragment.
    name: "createContextualFragment(",
    pattern: /\.createContextualFragment\s*\(/,
    allow: new Set<string>(),
  },
  {
    // iframe.srcdoc renders an HTML string as a live document — property form.
    name: ".srcdoc assignment",
    pattern: /\.srcdoc\s*=(?!=)/,
    allow: new Set<string>(),
  },
  {
    // iframe.srcdoc via setAttribute — the attribute form the .srcdoc= pattern
    // misses (Codex review #6).
    name: 'setAttribute("srcdoc")',
    pattern: /setAttribute\(\s*["']srcdoc["']/,
    allow: new Set<string>(),
  },
  {
    // Modern WHATWG string→DOM APIs (Codex round-3 review): Element.setHTMLUnsafe
    // and Document.parseHTMLUnsafe are the spec's stated successors to the
    // DOMParser/innerHTML family and bypass the older patterns.
    name: "setHTMLUnsafe(",
    pattern: /\.setHTMLUnsafe\s*\(/,
    allow: new Set<string>(),
  },
  {
    name: "parseHTMLUnsafe(",
    pattern: /\.parseHTMLUnsafe\s*\(/,
    allow: new Set<string>(),
  },
];

// The per-line `.test()` loop relies on a stateless match: a global/sticky
// regex would persist `lastIndex` across lines and silently skip violations.
// The type (`RegExp`) can't express "non-global", so assert it once at load.
for (const cp of CHOKE_POINTS) {
  if (cp.pattern.global || cp.pattern.sticky) {
    throw new Error(
      `ChokePoint "${cp.name}" pattern must not be global/sticky ` +
        `(lastIndex statefulness breaks per-line scanning)`
    );
  }
}

// --- scanner ----------------------------------------------------------------

/** Replace comment bytes with spaces, preserving newlines so line numbers
 *  survive. Block comments first (so a `//` inside one is already gone),
 *  then line comments. See the SCOPE / KNOWN GAPS note for why this regex
 *  stripper is safe for primitive detection. */
function stripComments(src: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return src.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
}

type SourceFile = { rel: string; content: string };
type Violation = { file: string; line: number; primitive: string; snippet: string };

function findViolations(files: readonly SourceFile[]): Violation[] {
  const out: Violation[] = [];
  for (const { rel, content } of files) {
    const lines = stripComments(content).split("\n");
    for (const cp of CHOKE_POINTS) {
      if (cp.allow.has(rel)) {
        continue;
      }
      lines.forEach((lineText, i) => {
        if (cp.pattern.test(lineText)) {
          out.push({ file: rel, line: i + 1, primitive: cp.name, snippet: lineText.trim() });
        }
      });
    }
  }
  return out;
}

const SCANNABLE = /\.(?:ts|tsx|mts|cts)$/;

function listSourceFiles(dir: string): SourceFile[] {
  const out: SourceFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(abs));
    } else if (entry.isFile() && SCANNABLE.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      out.push({
        rel: path.relative(ROOT, abs).split(path.sep).join("/"),
        content: readFileSync(abs, "utf8"),
      });
    }
  }
  return out;
}

// --- tests ------------------------------------------------------------------

describe("URL/security choke-point lint", () => {
  it("current src/** has zero URL primitives outside the choke-point allowlist", () => {
    const files = listSourceFiles(SRC);
    // Guard against a vacuous pass: a refactor that relocates src/ or breaks
    // the walk would leave the scan set empty and `toEqual([])` would still
    // pass while inspecting nothing. Pin a floor well under the current count.
    expect(files.length).toBeGreaterThan(20);
    const violations = findViolations(files);
    // Empty-array compare gives a readable diff of every file:line:primitive
    // if a regression lands.
    expect(violations).toEqual([]);
  });

  // NON-VACUITY: planting every primitive in a NON-allowlisted path must
  // trip the guard. Proves the suite is not vacuously green. (In-memory
  // fixture — no scratch file is committed to the repo tree.)
  it("flags every primitive when planted outside the allowlist (non-vacuity)", () => {
    const fixture: SourceFile[] = [
      {
        rel: "src/webview/cm/some-future-widget.ts",
        content: [
          "const u = new URL(userInput);",
          "anchor.href = userInput;",
          "image.src = userInput;",
          'node.setAttribute("href", userInput);',
          "env.openExternal(userInput);",
          "el.innerHTML = userInput;",
          "el.outerHTML = userInput;",
          'el.insertAdjacentHTML("beforeend", userInput);',
          "document.write(userInput);",
          "const p = new DOMParser();",
          "parser.parseFromString(userInput, 'text/html');",
          "range.createContextualFragment(userInput);",
          "frame.srcdoc = userInput;",
          'frame.setAttribute("srcdoc", userInput);',
          "el.setHTMLUnsafe(userInput);",
          "Document.parseHTMLUnsafe(userInput);",
        ].join("\n"),
      },
    ];
    const tripped = new Set(findViolations(fixture).map((v) => v.primitive));
    // Hardcoded literal expected set, NOT `CHOKE_POINTS.map(...)`: deriving
    // the expected from CHOKE_POINTS makes the assertion circular — deleting
    // or renaming a primitive shrinks both sides in lockstep and passes
    // vacuously. Pinning the literal names turns such a mutation red.
    expect(tripped).toEqual(
      new Set([
        "new URL(",
        ".href / .src assignment",
        'setAttribute("href"|"src")',
        "host env.openExternal()",
        ".innerHTML / .outerHTML assignment",
        "insertAdjacentHTML(",
        "document.write(",
        "new DOMParser(",
        "parseFromString(",
        "createContextualFragment(",
        ".srcdoc assignment",
        'setAttribute("srcdoc")',
        "setHTMLUnsafe(",
        "parseHTMLUnsafe(",
      ])
    );
  });

  // Stronger than the per-name set above: plant EVERY sub-token of each
  // multi-token primitive (both `.href`/`.src` and both setAttribute names)
  // and assert each planted line trips individually. The per-name set
  // collapses `.href`/`.src` and `setAttribute("href")`/`("src")` to one
  // name each, so dropping an alternation branch (e.g. `|src`) would still
  // pass it; the line-granular check below catches that.
  it("flags every primitive AND sub-token when planted outside the allowlist", () => {
    const expectations: ReadonlyArray<{ line: string; primitive: string }> = [
      { line: "const u = new URL(userInput);", primitive: "new URL(" },
      { line: "anchor.href = userInput;", primitive: ".href / .src assignment" },
      { line: "image.src = userInput;", primitive: ".href / .src assignment" },
      { line: 'node.setAttribute("href", userInput);', primitive: 'setAttribute("href"|"src")' },
      { line: 'node.setAttribute("src", userInput);', primitive: 'setAttribute("href"|"src")' },
      { line: "env.openExternal(userInput);", primitive: "host env.openExternal()" },
      { line: "el.innerHTML = userInput;", primitive: ".innerHTML / .outerHTML assignment" },
      { line: "el.outerHTML = userInput;", primitive: ".innerHTML / .outerHTML assignment" },
      {
        line: 'el.insertAdjacentHTML("beforeend", userInput);',
        primitive: "insertAdjacentHTML(",
      },
      { line: "document.write(userInput);", primitive: "document.write(" },
      { line: "const p = new DOMParser();", primitive: "new DOMParser(" },
      { line: "parser.parseFromString(x, 'text/html');", primitive: "parseFromString(" },
      { line: "range.createContextualFragment(x);", primitive: "createContextualFragment(" },
      { line: "frame.srcdoc = userInput;", primitive: ".srcdoc assignment" },
      { line: 'frame.setAttribute("srcdoc", userInput);', primitive: 'setAttribute("srcdoc")' },
      { line: "el.setHTMLUnsafe(userInput);", primitive: "setHTMLUnsafe(" },
      { line: "Document.parseHTMLUnsafe(userInput);", primitive: "parseHTMLUnsafe(" },
    ];
    for (const { line, primitive } of expectations) {
      const v = findViolations([{ rel: "src/webview/cm/some-future-widget.ts", content: line }]);
      expect(v.map((x) => x.primitive)).toContain(primitive);
    }
  });

  // ALLOWLIST LIVENESS: every allowlisted path must still exist AND still use
  // the primitive (after comment-stripping). Without this, a rename/delete/
  // split leaves a stale entry silently permitting the primitive at a path
  // that no longer exists — and a file later recreated there inherits an
  // unreviewed permission.
  it("every allowlist entry points at a real file that still uses the primitive", () => {
    const scanned = new Map(listSourceFiles(SRC).map((f) => [f.rel, f.content]));
    for (const cp of CHOKE_POINTS) {
      for (const rel of cp.allow) {
        const content = scanned.get(rel);
        expect(content, `allowlisted file missing: ${rel}`).toBeDefined();
        const stillUsed = stripComments(content ?? "")
          .split("\n")
          .some((l) => cp.pattern.test(l));
        expect(stillUsed, `dead allow entry: ${rel} no longer uses ${cp.name}`).toBe(true);
      }
    }
  });

  it("does NOT flag a primitive that is inside its allowlisted file", () => {
    const fixture: SourceFile[] = [
      { rel: "src/webview/cm/image/image-widget.ts", content: "img.src = this.safeUrl;" },
      {
        rel: "src/extension/quoll-editor-panel.ts",
        content: "openExternal: (url) => env.openExternal(Uri.parse(url)),",
      },
    ];
    expect(findViolations(fixture)).toEqual([]);
  });

  it("ignores primitives that appear only in comments", () => {
    // Pins the test-harness.ts:94 JSDoc false-positive class: a comment that
    // quotes the production snippet verbatim must not trip the guard.
    const fixture: SourceFile[] = [
      {
        rel: "src/extension/not-a-gate.ts",
        content: [
          "// example: env.openExternal(Uri.parse(url))",
          "/** anchor.href = x; const u = new URL(y); */",
          "const ok = 1;",
        ].join("\n"),
      },
    ];
    expect(findViolations(fixture)).toEqual([]);
  });

  it("treats === / == comparisons as non-assignments", () => {
    expect(
      findViolations([{ rel: "src/x.ts", content: "if (a.href === b) {}\nif (a.src == c) {}" }])
    ).toEqual([]);
  });

  it("does not treat .srcset / .source as a .src assignment (token-boundary)", () => {
    // Trips only if the pattern is relaxed to a prefix match.
    expect(
      findViolations([{ rel: "src/x.ts", content: "img.srcset = x;\nobj.source = y;" }])
    ).toEqual([]);
  });
});
