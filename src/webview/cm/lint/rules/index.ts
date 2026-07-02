import type { LintRule } from "../types.js";
import { duplicateHeadingText } from "./duplicate-heading-text.js";
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
