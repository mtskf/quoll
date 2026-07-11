import { collectProseParagraphs } from "../prose-scan.js";
import type { LintContext, LintDiagnostic, LintRule } from "../types.js";

// A curated intensifier / hedge list — words that usually add nothing and read
// as filler (iA-Writer / write-good "weasel" spirit). Kept small and
// high-precision: only single words that are almost always droppable, so the
// false-positive rate stays low. Matched whole-word + case-insensitively, so
// "just" is flagged but "justice" is not. Multi-word hedges ("of course") are
// out of scope for the single-word regex.
const FILLERS = [
  "very",
  "really",
  "quite",
  "just",
  "actually",
  "basically",
  "simply",
  "literally",
  "virtually",
  "essentially",
  "extremely",
  "totally",
  "completely",
  "definitely",
  "certainly",
  "absolutely",
  "rather",
  "somewhat",
  "fairly",
  "honestly",
  "truly",
  "obviously",
  "clearly",
];

// New regex per call (no shared lastIndex). \b word boundaries + case-insensitive.
function fillerRegex(): RegExp {
  return new RegExp(`\\b(?:${FILLERS.join("|")})\\b`, "gi");
}

export const fillerWords: LintRule = (ctx: LintContext): LintDiagnostic[] => {
  const diagnostics: LintDiagnostic[] = [];
  for (const para of collectProseParagraphs(ctx.tree, ctx.text)) {
    const re = fillerRegex();
    let m: RegExpExecArray | null = re.exec(para.text);
    while (m !== null) {
      diagnostics.push({
        from: para.from + m.index,
        to: para.from + m.index + m[0].length,
        severity: "info",
        code: "filler-words",
        message: `Filler word "${m[0]}"; consider removing it.`,
      });
      m = re.exec(para.text);
    }
  }
  return diagnostics;
};
