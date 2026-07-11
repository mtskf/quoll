import { collectProseParagraphs, countWords } from "../prose-scan.js";
import type { LintContext, LintDiagnostic, LintRule } from "../types.js";

// Flag a sentence longer than this many words. 30 is a common readability
// threshold (write-good / iA Writer territory); a module const so it is easy to
// retune and is referenced once.
const MAX_WORDS = 30;

// Sentence terminator: one or more of . ! ? followed by whitespace or end. New
// regex per call (no shared lastIndex). Abbreviations ("e.g.", "3.14") can
// mis-split, but the effect is only a slightly different word count on an
// advisory info squiggle — acceptable, and kept simple on purpose.
function terminatorRegex(): RegExp {
  return /[.!?]+(?=\s|$)/g;
}

export const longSentence: LintRule = (ctx: LintContext): LintDiagnostic[] => {
  const diagnostics: LintDiagnostic[] = [];
  for (const para of collectProseParagraphs(ctx.tree, ctx.text)) {
    const t = para.text;

    // Emit a diagnostic for the sentence spanning [start, end) if it is too long,
    // trimming leading whitespace so the underline starts at the first word.
    const consider = (start: number, end: number): void => {
      let a = start;
      while (a < end && /\s/.test(t.charAt(a))) {
        a += 1;
      }
      if (a >= end) {
        return; // whitespace-only tail
      }
      const count = countWords(t.slice(a, end));
      if (count > MAX_WORDS) {
        diagnostics.push({
          from: para.from + a,
          to: para.from + end,
          severity: "info",
          code: "long-sentence",
          message: `Long sentence (${count} words); consider splitting it.`,
        });
      }
    };

    const re = terminatorRegex();
    let start = 0;
    let m: RegExpExecArray | null = re.exec(t);
    while (m !== null) {
      const end = m.index + m[0].length;
      consider(start, end);
      start = end;
      m = re.exec(t);
    }
    if (start < t.length) {
      consider(start, t.length); // trailing sentence with no terminator
    }
  }
  return diagnostics;
};
