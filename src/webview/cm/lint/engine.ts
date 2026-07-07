import { markdownLanguage } from "@codemirror/lang-markdown";
import type { ChangedRange } from "@lezer/common";
import { TreeFragment } from "@lezer/common";
import { frontmatterContentLines, leadingFrontmatterBodyStart } from "./frontmatter-range.js";
import { FRONTMATTER_RULES, RULES } from "./rules/index.js";
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

// The parse tree type, taken from the parser's own return type so the cache
// field stays honest if the parser's tree shape ever changes upstream.
type ParseTree = ReturnType<typeof PARSER.parse>;

// Run every body lint rule over an already-parsed body and return the findings
// re-offset back into whole-document coordinates by the sliced-off frontmatter
// length. UNSORTED — `combine` merges these with the frontmatter findings and
// sorts the union once.
function lintBody(text: string, tree: ParseTree, bodyStart: number): LintDiagnostic[] {
  const ctx = { text, tree };
  return RULES.flatMap((rule) => rule(ctx)).map((d) =>
    bodyStart > 0 ? shiftDiagnostic(d, bodyStart) : d
  );
}

// Run the frontmatter lint pass over the sliced-off leading block. `bodyStart` is
// that block's length (0 when the document has no frontmatter). The block starts
// at document offset 0, so its content-line offsets are already absolute and are
// merged WITHOUT the body-rule shift.
function lintFrontmatter(raw: string, bodyStart: number): LintDiagnostic[] {
  if (bodyStart === 0) {
    return []; // no leading frontmatter block at all
  }
  // A block exists (bodyStart>0 => sliceBody found a closer). Run the rules even
  // when the block has no content lines, so a future FRONTMATTER_RULE that flags
  // an EMPTY block (e.g. required-key-missing) still fires; today's rule simply
  // returns [] on an empty content set.
  const contentLines = frontmatterContentLines(raw.slice(0, bodyStart));
  return FRONTMATTER_RULES.flatMap((rule) => rule({ contentLines }));
}

// Merge the frontmatter-pass findings (absolute) with the body findings (shifted
// to absolute) and sort by position (from, then to). Shared by BOTH entry points
// so they produce identical output for a given (raw, tree).
function combine(
  raw: string,
  bodyDiagnostics: LintDiagnostic[],
  bodyStart: number
): LintDiagnostic[] {
  const diagnostics = [...lintFrontmatter(raw, bodyStart), ...bodyDiagnostics];
  diagnostics.sort((a, b) => a.from - b.from || a.to - b.to);
  return diagnostics;
}

// Slice the file-leading frontmatter off `raw` (see the module note below) and
// return [bodyText, bodyStart]. A leading YAML frontmatter block is EXCLUDED
// from linting: it is not Markdown, so linting its bytes yields only false
// positives (a `# comment` reads as a heading, trailing spaces / double blanks
// get flagged, and a frontmatter heading collides with a body heading). We lint
// the body substring alone and re-offset findings, matching markdownlint's
// default of skipping front matter. This lives in the engine (not a rule) so
// tree-walking rules never SEE the frontmatter heading — a post-filter of
// findings-in-range could not undo a cross-boundary duplicate/increment.
function sliceBody(raw: string): [text: string, bodyStart: number] {
  const bodyStart = leadingFrontmatterBodyStart(raw);
  return [bodyStart > 0 ? raw.slice(bodyStart) : raw, bodyStart];
}

// Run every first-party lint rule over raw Markdown and return the findings
// sorted by position (from, then to). This is the Quoll-native lint contract: a
// pure function of the raw text, with zero CodeMirror-view or DOM dependency, so
// it is unit-testable in isolation and reusable by any future surface (e.g. a
// host-side VS Code DiagnosticCollection) behind the same signature. May throw
// on pathological input (the parser's own failure mode); callers that drive the
// editor wrap it in `safeLint` (extension.ts) for fail-open behaviour.
export function lintMarkdown(raw: string): LintDiagnostic[] {
  const [text, bodyStart] = sliceBody(raw);
  return combine(raw, lintBody(text, PARSER.parse(text), bodyStart), bodyStart);
}

// A single conservative changed range bracketing where two strings differ:
// the common-prefix length as the start, and the common-suffix (bounded so it
// never overlaps the prefix in either string) as the tail. Coordinates are
// UTF-16 code units, matching CodeMirror/Lezer position space. This is a
// superset of the real edit — enough for `TreeFragment.applyChanges` to know
// which fragments to drop; a slightly-wide range only reduces reuse, never
// correctness. Identical strings yield an empty range (full reuse).
export function diffRange(a: string, b: string): ChangedRange {
  const max = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) {
    prefix += 1;
  }
  let suffix = 0;
  const maxSuffix = Math.min(a.length - prefix, b.length - prefix);
  while (
    suffix < maxSuffix &&
    a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  return { fromA: prefix, toA: a.length - suffix, fromB: prefix, toB: b.length - suffix };
}

// A STATEFUL linter that reuses the previous call's parse tree via Lezer
// `TreeFragment` incremental parsing, so a typing pause no longer costs a full
// re-parse. It caches the previous BODY text (post-frontmatter) + its complete
// tree; on the next call it diffs old-vs-new body into one `ChangedRange`,
// adjusts the previous tree's fragments, and re-parses only the affected span.
// Output is IDENTICAL to `lintMarkdown` for the same input: our cached tree is
// always COMPLETE (synchronous parse, no time budget), so a fragment-reused
// parse yields the same node structure as a full parse — the property
// `syntaxTree(state)` cannot offer (it may be incomplete). Instance-per-
// EditorView: the debounced compute plugin owns one, cleared implicitly when the
// plugin is destroyed. Pinned by the tree-shape parity + diagnostics-equivalence
// tests, not taken on faith.
export function createIncrementalLinter(): (raw: string) => LintDiagnostic[] {
  let prevBody: string | null = null;
  let prevTree: ParseTree | null = null;
  return (raw: string): LintDiagnostic[] => {
    const [text, bodyStart] = sliceBody(raw);
    let tree: ParseTree;
    if (prevBody === null || prevTree === null) {
      tree = PARSER.parse(text);
    } else {
      const fragments = TreeFragment.applyChanges(TreeFragment.addTree(prevTree), [
        diffRange(prevBody, text),
      ]);
      tree = PARSER.parse(text, fragments);
    }
    // The cache records the completed PARSE, not lint success: update it here,
    // before running the rules, so that even if a rule below throws the cached
    // (text, tree) pair stays a valid parse of `text` for the next diff. Order
    // is deliberate — do NOT move these below `lintBody` "to be safe".
    prevBody = text;
    prevTree = tree;
    return combine(raw, lintBody(text, tree, bodyStart), bodyStart);
  };
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
