import type { FrontmatterLintRule, LintRule } from "../types.js";
import { duplicateHeadingText } from "./duplicate-heading-text.js";
import { frontmatterStructure } from "./frontmatter-structure.js";
import { headingIncrement } from "./heading-increment.js";
import { noMultipleBlanks } from "./no-multiple-blanks.js";
import { noTrailingSpaces } from "./no-trailing-spaces.js";

// The active first-party lint rule set. New rules are appended here; the engine
// runs them in array order and sorts the combined output by position.
export const RULES: readonly LintRule[] = [
  headingIncrement,
  noTrailingSpaces,
  noMultipleBlanks,
  duplicateHeadingText,
];

// Rules that lint the file-leading YAML frontmatter block, which the engine
// slices OFF before the body RULES run (frontmatter is not Markdown). Kept a
// SEPARATE array precisely because a body rule (heading-increment etc.) must
// never run over frontmatter — that is the reason the engine slices it. Run by
// the engine's dedicated frontmatter pass; their offsets are already absolute.
export const FRONTMATTER_RULES: readonly FrontmatterLintRule[] = [frontmatterStructure];
