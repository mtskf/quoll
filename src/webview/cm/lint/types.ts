import type { syntaxTree } from "@codemirror/language";

// The Lezer tree type, derived from syntaxTree's return type rather than
// imported from @lezer/common: that package is a transitive-only, un-hoisted
// dep, and a direct import would violate the repo's supply-chain default-deny.
// Mirrors src/webview/cm/decorations/types.ts and src/markdown/lezer-url-walker.ts.
export type LezerTree = ReturnType<typeof syntaxTree>;

// Advisory severities only. The lint layer NEVER emits "error": correctness /
// security failures that must block a disk write are the host write-gate's
// domain (validate-for-write.ts), not advisory lint. Keeping "error" out by
// policy stops an advisory squiggle from ever reading as a write-blocking
// failure. Shaped to map 1:1 onto CodeMirror's Diagnostic so a future
// @codemirror/lint adapter is a pure rename, not a redesign.
export type LintSeverity = "warning" | "info";

// A single advisory finding over the raw Markdown text. Offsets are absolute
// UTF-16 code-unit positions into the document (CodeMirror's position space),
// so a diagnostic maps 1:1 onto a CodeMirror range.
export type LintDiagnostic = {
  readonly from: number;
  readonly to: number;
  readonly severity: LintSeverity;
  // Stable rule id, e.g. "heading-increment". Shown in the tooltip + asserted by tests.
  readonly code: string;
  readonly message: string;
  // Optional autofix descriptor (a CodeMirror ChangeSpec). Populated by
  // no-trailing-spaces; applied ONLY by the explicit applyLintFixAtSelection
  // command (Mod-.), which re-lints the live doc before applying — NEVER
  // automatically. The display cache (lintField) does not map this field: the
  // apply path re-lints fresh rather than trusting the cached range. Stays
  // off-wire (toWireDiagnostics never projects it).
  readonly fix?: { readonly from: number; readonly to: number; readonly insert: string };
  // Marks a finding that covers a whole line whose flagged content is empty or
  // whitespace-only — e.g. a blank line (no-multiple-blanks), where an inline mark
  // would be invisible. Such a finding is given NO in-editor decoration:
  // buildLintDecorations skips it because a filled full-line `Decoration.line` with
  // an inset left-bar is indistinguishable from a blockquote's left rule and would
  // read as a phantom blockquote. It surfaces instead via the Problems mirror, the
  // opt-in gutter dot, and the hover tooltip. CONTRACT: `from` is a line-start
  // offset; `to` is the line's content end (equal to `from` for a truly empty line,
  // the whitespace-run end for a whitespace-only line) and is INCLUSIVE in the hover
  // hit-test so the tooltip covers the whole blank line. The field mapping
  // (lintField.update) re-anchors `from` after every change and drops the diagnostic
  // if it stops being a line start (collapsing `to` to `from` for the debounce
  // window) so the gutter dot / hover stay attributed to the correct line.
  // Display-only and off-wire: `toWireDiagnostics` ignores the flag; it only steers
  // the debounce-window mapping and the hover hit-test.
  readonly wholeLine?: boolean;
};

// Input a rule sees: the raw document text plus its fully-parsed Lezer tree.
// Rules are pure — (text, tree) in, diagnostics out, no CodeMirror view, no DOM.
export type LintContext = {
  readonly text: string;
  readonly tree: LezerTree;
};

// A lint rule: a pure function from context to zero or more diagnostics.
export type LintRule = (ctx: LintContext) => LintDiagnostic[];
