import { scanLines } from "../line-scan.js";
import type { LintContext, LintDiagnostic, LintRule } from "../types.js";

// A line that is empty or whitespace-only.
const BLANK = /^[ \t]*$/;
// Code-block node names whose interior blank lines are legitimate content, not a
// stylistic gap. FencedCode = ```/~~~ fences; CodeBlock = 4-space-indented blocks.
const CODE_BLOCK = /^(?:FencedCode|CodeBlock)$/;

// MD012-equivalent: flag consecutive blank lines beyond the first. A run of N
// blank lines (N >= 2) flags lines 2..N — one whole-line diagnostic per excess
// blank line (the first blank in the run is the allowed separator). Blank lines
// INSIDE a code block are exempt. Each diagnostic is zero-length at the blank
// line's start with `wholeLine: true`: it carries NO in-editor decoration (a
// full-line block would read as a phantom blockquote) and surfaces via the
// Problems mirror, the opt-in gutter dot, and the hover tooltip. severity "info":
// cosmetic whitespace, never a correctness issue.
export const noMultipleBlanks: LintRule = (ctx: LintContext): LintDiagnostic[] => {
  // [from, to) spans of code blocks; a blank line whose start falls inside one is
  // exempt. Built from the same Lezer tree the editor renders. Spans per document
  // are few and the rule runs debounced off the keystroke path, so the per-blank
  // `.some()` lookup below is acceptable (no sorted-pointer sweep needed).
  const codeSpans: { from: number; to: number }[] = [];
  ctx.tree.iterate({
    enter: (node) => {
      if (CODE_BLOCK.test(node.name)) {
        codeSpans.push({ from: node.from, to: node.to });
      }
    },
  });
  const inCodeBlock = (offset: number): boolean =>
    codeSpans.some((s) => offset >= s.from && offset < s.to);

  const lines = scanLines(ctx.text);
  // scanLines always appends a final terminator-less entry. When the document
  // ends with a newline, that entry is a phantom empty line at EOF (not a line
  // the user sees), so a single trailing newline would otherwise read as a blank
  // line. Drop it so trailing-newline counting matches what the editor shows.
  if (lines.length > 1 && /[\r\n]$/.test(ctx.text)) {
    lines.pop();
  }

  const diagnostics: LintDiagnostic[] = [];
  let blankRun = 0;
  for (const { content, from } of lines) {
    if (BLANK.test(content)) {
      blankRun += 1;
      if (blankRun >= 2 && !inCodeBlock(from)) {
        diagnostics.push({
          from,
          // Span the blank line's content (zero-length for a truly empty line,
          // the whitespace run for a whitespace-only line) so the hover hit-test
          // (diagnosticsAt) covers the whole line, not just column 0. The line
          // decoration is anchored at `from` regardless of `to`.
          to: from + content.length,
          severity: "info",
          code: "no-multiple-blanks",
          message: "Multiple consecutive blank lines; collapse to a single blank line.",
          wholeLine: true,
        });
      }
    } else {
      blankRun = 0;
    }
  }
  return diagnostics;
};
