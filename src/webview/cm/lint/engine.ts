import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { RULES } from "./rules/index.js";
import type { LintDiagnostic } from "./types.js";

// The GFM-configured Markdown parser, matching what the editor renders. Mirrors
// src/markdown/lezer-url-walker.ts — `.language.parser` is the underlying Lezer
// parser; `.parse(text)` is synchronous and returns a COMPLETE tree (unlike
// CodeMirror's time-budgeted `syntaxTree(state)`), so rules always see the whole
// document. Hoisted to module scope so the parser is built once, not per call.
const PARSER = markdown({ base: markdownLanguage }).language.parser;

// Run every first-party lint rule over raw Markdown and return the findings
// sorted by position (from, then to). This is the Quoll-native lint contract: a
// pure function of the raw text, with zero CodeMirror-view or DOM dependency, so
// it is unit-testable in isolation and reusable by any future surface (e.g. a
// host-side VS Code DiagnosticCollection) behind the same signature. May throw
// on pathological input (the parser's own failure mode); callers that drive the
// editor wrap it in `safeLintMarkdown` (extension.ts) for fail-open behaviour.
export function lintMarkdown(raw: string): LintDiagnostic[] {
  const ctx = { text: raw, tree: PARSER.parse(raw) };
  const diagnostics = RULES.flatMap((rule) => rule(ctx));
  diagnostics.sort((a, b) => a.from - b.from || a.to - b.to);
  return diagnostics;
}
