import { markdownLanguage } from "@codemirror/lang-markdown";
import { leadingFrontmatterBodyStart } from "./frontmatter-range.js";
import { RULES } from "./rules/index.js";
import type { LintDiagnostic } from "./types.js";

// The GFM-configured Markdown parser, matching what the editor renders. Point
// straight at `markdownLanguage.parser` (a MarkdownParser) instead of building it
// via `markdown({ base: markdownLanguage })` — the `markdown()` wrapper adds a
// `parseCode` sub-parser + the HTML-tag language stack the webview bundle must not
// carry (see cm/markdown.ts). Lint rules only read the TOP-LEVEL Markdown tree,
// which `parseCode` never changes, so the swap is tree-shape-identical for lint
// while dropping @codemirror/lang-html transitively. Mirrors the host-side
// URL-walker swap (#6). `.parse(text)` is synchronous and returns a COMPLETE tree
// (unlike CodeMirror's time-budgeted `syntaxTree(state)`), so rules see the whole
// document. Hoisted to module scope so the parser is referenced once, not per call.
const PARSER = markdownLanguage.parser;

// Run every first-party lint rule over raw Markdown and return the findings
// sorted by position (from, then to). This is the Quoll-native lint contract: a
// pure function of the raw text, with zero CodeMirror-view or DOM dependency, so
// it is unit-testable in isolation and reusable by any future surface (e.g. a
// host-side VS Code DiagnosticCollection) behind the same signature. May throw
// on pathological input (the parser's own failure mode); callers that drive the
// editor wrap it in `safeLintMarkdown` (extension.ts) for fail-open behaviour.
//
// A file-leading YAML frontmatter block is EXCLUDED: it is not Markdown, so
// linting its bytes yields only false positives (a `# comment` reads as a
// heading, trailing spaces / double blanks get flagged, and a frontmatter
// heading collides with a body heading). We lint the body substring alone and
// re-offset findings back into document coordinates, matching markdownlint's
// default of skipping front matter. This must stay in the engine (not a rule)
// so tree-walking rules never SEE the frontmatter heading — a post-filter of
// findings-in-range could not undo a cross-boundary duplicate/increment.
export function lintMarkdown(raw: string): LintDiagnostic[] {
  const bodyStart = leadingFrontmatterBodyStart(raw);
  const text = bodyStart > 0 ? raw.slice(bodyStart) : raw;
  const ctx = { text, tree: PARSER.parse(text) };
  const diagnostics = RULES.flatMap((rule) => rule(ctx)).map((d) =>
    bodyStart > 0 ? shiftDiagnostic(d, bodyStart) : d
  );
  diagnostics.sort((a, b) => a.from - b.from || a.to - b.to);
  return diagnostics;
}

// Shift a body-relative diagnostic back into whole-document coordinates by the
// sliced-off frontmatter length. Covers the optional autofix range too so the
// squiggle and its fix keep describing the same bytes.
function shiftDiagnostic(d: LintDiagnostic, offset: number): LintDiagnostic {
  return {
    ...d,
    from: d.from + offset,
    to: d.to + offset,
    ...(d.fix ? { fix: { ...d.fix, from: d.fix.from + offset, to: d.fix.to + offset } } : {}),
  };
}
