import { collectHeadings } from "../../headings.js";
import type { LintContext, LintDiagnostic, LintRule } from "../types.js";

// Reduce an ATX heading line to its comparable text: drop an optional
// space-preceded closing `#` sequence FIRST, then the opening `#` marker (and its
// required following space, or end-of-line for an empty heading), then trim and
// collapse internal whitespace. Closing-before-opening matters for empty headings
// like `# #` / `## ##`: the single space there is what makes the trailing hashes a
// CommonMark closing sequence, so it must be stripped before the opener regex
// consumes it — otherwise the result is a stray `#`/`##` rather than "" (which
// would mis-flag two empty headings as duplicates). CommonMark only treats a `#`
// run as a CLOSING sequence when whitespace precedes it, so "C#" (no preceding
// space) keeps its hash. This is TEXTUAL normalization only — inline markup
// (emphasis, links, code) is NOT resolved — so it is a heuristic for "the same
// heading", deliberately kept pure and dependency-free; the message below is
// hedged to match.
function headingText(raw: string): string {
  return raw
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/^#{1,6}(?:[ \t]+|$)/, "")
    .trim()
    .replace(/[ \t]+/g, " ");
}

// MD024-equivalent: flag a heading whose text repeats an earlier heading's text.
// Repeated headings tend to collide as link anchors / TOC entries, so the SECOND
// and later occurrences are flagged (the first is canonical). Document-wide (not
// siblings-only) and case-sensitive. Setext headings (=== / ---) are out of scope,
// matching heading-increment.ts. Empty headings are ignored (no text to compare).
// The diagnostic range covers the whole heading node, so the underline is always
// visible. severity "warning": a likely-unintended repeat is more than cosmetic.
export const duplicateHeadingText: LintRule = (ctx: LintContext): LintDiagnostic[] => {
  const seen = new Set<string>();
  const diagnostics: LintDiagnostic[] = [];
  for (const h of collectHeadings(ctx.tree)) {
    const text = headingText(ctx.text.slice(h.from, h.to));
    if (text === "") {
      continue; // empty heading: nothing to compare
    }
    if (seen.has(text)) {
      diagnostics.push({
        from: h.from,
        to: h.to,
        severity: "warning",
        code: "duplicate-heading-text",
        message: `Duplicate heading text "${text}"; repeated headings can collide as link anchors.`,
      });
    } else {
      seen.add(text);
    }
  }
  return diagnostics;
};
