import { collectProseParagraphs } from "../prose-scan.js";
import type { LintContext, LintDiagnostic, LintRule } from "../types.js";

// A `write-good`-style passive-voice heuristic: a form of "to be" followed
// (optionally by one -ly adverb) by a past participle — a word ending in "ed"
// OR one of a curated irregular-participle set. Purely textual and advisory: it
// cannot know the syntax, so it will occasionally flag a predicate adjective
// ("is tired"); severity "info" and the hedged message ("consider") match that.
const BE = "(?:am|is|are|was|were|be|been|being)";

// Common irregular past participles (subset of write-good's list) that do not
// end in "ed" and so would be missed by the "\w+ed" branch alone.
const IRREGULAR = [
  "written",
  "made",
  "done",
  "taken",
  "given",
  "seen",
  "held",
  "kept",
  "told",
  "brought",
  "found",
  "built",
  "sent",
  "known",
  "shown",
  "born",
  "worn",
  "torn",
  "drawn",
  "thrown",
  "grown",
  "blown",
  "flown",
  "chosen",
  "frozen",
  "spoken",
  "broken",
  "stolen",
  "driven",
  "risen",
  "hidden",
  "beaten",
  "eaten",
  "fallen",
  "forgotten",
  "forgiven",
  "gotten",
  "bitten",
  "bound",
  "caught",
  "taught",
  "bought",
  "fought",
  "sought",
  "paid",
  "laid",
  "said",
  "read",
  "met",
  "set",
  "put",
  "cut",
  "hurt",
  "lost",
  "left",
  "felt",
  "dealt",
  "meant",
  "sold",
  "heard",
  "understood",
].join("|");

// New regex per call (no shared lastIndex across invocations). Case-insensitive,
// word-anchored; the span runs from the be-form through the participle.
function passiveRegex(): RegExp {
  return new RegExp(`\\b${BE}\\s+(?:\\w+ly\\s+)?(?:\\w+ed|${IRREGULAR})\\b`, "gi");
}

export const passiveVoice: LintRule = (ctx: LintContext): LintDiagnostic[] => {
  const diagnostics: LintDiagnostic[] = [];
  for (const para of collectProseParagraphs(ctx.tree, ctx.text)) {
    const re = passiveRegex();
    let m: RegExpExecArray | null = re.exec(para.text);
    while (m !== null) {
      diagnostics.push({
        from: para.from + m.index,
        to: para.from + m.index + m[0].length,
        severity: "info",
        code: "passive-voice",
        message: "Passive voice; consider an active construction.",
      });
      m = re.exec(para.text);
    }
  }
  return diagnostics;
};
