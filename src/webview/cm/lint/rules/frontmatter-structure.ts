import type { FrontmatterLintContext, FrontmatterLintRule, LintDiagnostic } from "../types.js";

// Line-content classifiers (fences are already stripped upstream, so these only
// ever see content lines). Order of application matters — see the loop below.
const BLANK = /^[ \t]*$/; // empty / whitespace-only: ignore
const COMMENT = /^[ \t]*#/; // YAML comment: ignore
const INDENTED = /^[ \t]/; // nested / multi-line-value continuation: accept (see plan scope note)
const LIST_ITEM = /^-(?:[ \t].*)?$/; // top-level sequence item `-` / `- value`: accept
// A top-level mapping key at column 0: some non-colon key text, a colon, then
// whitespace-and-value OR end-of-line. Requiring the space/EOL after the colon is
// deliberate — `key:value` is a YAML plain scalar, not a mapping entry, so it is
// left to the malformed branch. Capture group 1 is the key name (for de-dup).
const TOP_LEVEL_KEY = /^([^:]+):(?:[ \t].*)?$/;

// SCOPE: a line-level advisory, NOT a YAML validator. Any `text: value` (or
// `text:`) at column 0 is treated as a key — including quoted/dotted keys that the
// reveal widget's stricter CLEAN_PAIR (frontmatter-widget.ts) renders raw. It
// deliberately does NOT validate YAML indicator characters or unify quoted vs
// unquoted keys (that needs a parser, which the TODO forbids). Consequences: keys
// are de-duplicated by LITERAL text (`"title"` != `title`), and a genuinely
// YAML-invalid indicator-led line (e.g. `@x: 1`) is accepted rather than flagged —
// an acceptable false-negative for an advisory lint.

// Advisory structural lint for a file-leading YAML frontmatter block. The block
// is concealed / reveal-gated in the editor, so a duplicated key or a malformed
// line never surfaces visually — this lint provides value the editor surface
// cannot. Two defects, one rule:
//   - duplicate top-level key: the 2nd+ col-0 `key:` line reusing an earlier key.
//   - malformed line: a col-0, non-blank, non-comment line that is neither a
//     `key:` mapping entry nor a `-` list item.
// Line-level classification only — NO YAML parse (per the TODO). The rule is
// fence-agnostic: `frontmatterContentLines` (frontmatter-range.ts) hands it only
// the lines between the fences, each with an absolute `from`, so the rule imports
// nothing from `src/markdown/` and emits already-absolute offsets. severity
// "warning": a structural defect is more than cosmetic. Advisory only — no `fix`.
export const frontmatterStructure: FrontmatterLintRule = (
  ctx: FrontmatterLintContext
): LintDiagnostic[] => {
  const diagnostics: LintDiagnostic[] = [];
  const seenKeys = new Set<string>();

  for (const { content, from } of ctx.contentLines) {
    if (BLANK.test(content) || COMMENT.test(content) || INDENTED.test(content)) {
      continue;
    }
    if (LIST_ITEM.test(content)) {
      continue; // top-level sequence item: structurally valid
    }
    const keyMatch = TOP_LEVEL_KEY.exec(content);
    if (keyMatch) {
      // keyMatch[1] is the key-name capture (present when the regex matches).
      const key = (keyMatch[1] ?? "").trim();
      if (seenKeys.has(key)) {
        diagnostics.push({
          from,
          to: from + content.length,
          severity: "warning",
          code: "frontmatter-duplicate-key",
          message: `Duplicate frontmatter key "${key}"; duplicates an earlier key.`,
        });
      } else {
        seenKeys.add(key);
      }
      continue;
    }
    diagnostics.push({
      from,
      to: from + content.length,
      severity: "warning",
      code: "frontmatter-malformed-line",
      message:
        "Malformed frontmatter line; expected `key: value`, a nested/indented value, or a `- ` list item.",
    });
  }
  return diagnostics;
};
