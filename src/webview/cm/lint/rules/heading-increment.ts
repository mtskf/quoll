import type { LintContext, LintDiagnostic, LintRule } from "../types.js";

const ATX_HEADING = /^ATXHeading([1-6])$/;

// MD001-equivalent: heading levels must not jump by more than one. A document
// that goes h1 -> h3 (skipping h2) gets a warning on the h3 line. Setext
// headings (=== / ---) are out of scope here, matching heading-reveal.ts.
export const headingIncrement: LintRule = (ctx: LintContext): LintDiagnostic[] => {
  const headings: { level: number; from: number; to: number }[] = [];
  ctx.tree.iterate({
    enter: (node) => {
      const m = ATX_HEADING.exec(node.name);
      if (m) {
        // m[1] is the level digit captured by the regex group (present when m is non-null).
        headings.push({ level: Number(m[1]), from: node.from, to: node.to });
      }
    },
  });

  const diagnostics: LintDiagnostic[] = [];
  let prevLevel = 0;
  for (const h of headings) {
    if (prevLevel !== 0 && h.level > prevLevel + 1) {
      diagnostics.push({
        from: h.from,
        to: h.to,
        severity: "warning",
        code: "heading-increment",
        message: `Heading levels should increment by one: an h${prevLevel} is followed by an h${h.level} (expected h${prevLevel + 1} or lower).`,
      });
    }
    prevLevel = h.level;
  }
  return diagnostics;
};
