import { scanLines } from "../line-scan.js";
import type { LintContext, LintDiagnostic, LintRule } from "../types.js";

// Trailing whitespace run at the end of a line's content (terminator stripped).
const TRAILING_WS = /[ \t]+$/;
// True when the line has at least one non-whitespace character.
const HAS_CONTENT = /\S/;

// MD009-equivalent: flag trailing whitespace on a content line. Exempts the
// Markdown hard line break (exactly two trailing spaces, no tab) so intentional
// `text  \n` breaks are not false-flagged. Whitespace-only (blank) lines are NOT
// this rule's concern (and a mark over an empty line would be invisible), so
// they are skipped. Pure text scan — no syntax tree needed. The range covers the
// trailing whitespace itself (always >= 1 char, so the underline is visible).
export const noTrailingSpaces: LintRule = (ctx: LintContext): LintDiagnostic[] => {
  const diagnostics: LintDiagnostic[] = [];
  for (const { content, from, terminated } of scanLines(ctx.text)) {
    const match = TRAILING_WS.exec(content);
    if (match !== null && HAS_CONTENT.test(content)) {
      // match[0] is the matched trailing-whitespace run (present whenever match is non-null).
      const ws = match[0];
      // A Markdown hard line break is exactly two trailing spaces on a TERMINATED
      // line (it needs a following line to break to). Two spaces at EOF (no
      // terminator) are just trailing whitespace, so they ARE flagged.
      //
      // Hard-break policy for 3+ trailing spaces (decided 2026-06-27): CommonMark
      // treats TWO-OR-MORE trailing spaces as a valid hard break, so a 3+-space
      // run is a *non-idiomatic* hard break, not strictly malformed. We still
      // treat it as ACCIDENTAL: only the canonical exactly-two form is exempt
      // (matches markdownlint MD009's `br_spaces: 2` default — counts ≠ 2 are
      // flagged). Consequently the opt-in autofix below deletes the whole run
      // rather than trimming it to two. Full removal — NOT trim-to-two — is the
      // deliberate choice: trim-to-two would silently CEMENT a hard break from
      // whitespace that was probably accidental, and (worse) the result is then
      // exempt from re-linting, so the unwanted invisible `<br>` could never be
      // surfaced again. An author who genuinely wanted a break re-adds `  ` or a
      // trailing `\` after the explicit, opt-in fix; that recourse is cheap and
      // visible, whereas a silently-created break is not. See SPEC.md "lint" and
      // LEARNING.md for the full rationale and the rejected alternatives.
      const isHardBreak = terminated && ws === "  ";
      if (!isHardBreak) {
        const start = from + match.index;
        const end = from + content.length; // end of content, before the terminator
        diagnostics.push({
          from: start,
          to: end,
          severity: "warning",
          code: "no-trailing-spaces",
          message: ws.includes("\t")
            ? "Trailing whitespace includes a tab; remove it."
            : `Trailing whitespace (${ws.length} space${ws.length === 1 ? "" : "s"}); remove it.`,
          // Opt-in autofix: deleting the trailing-whitespace run trims the line.
          // Applied ONLY by the explicit applyLintFixAtSelection command (Mod-.),
          // which re-lints fresh before applying — never automatically. Same range
          // as the underline so the squiggle and its fix describe the same bytes.
          fix: { from: start, to: end, insert: "" },
        });
      }
    }
  }
  return diagnostics;
};
