// StateField that collapses long TOP-LEVEL blockquotes / callouts: more than
// COLLAPSE_THRESHOLD source lines render their first 10 lines plus a "Show more" bar, the
// rest concealed by a block Decoration.replace. A second client of the shared collapse
// reducer (../collapse/line-collapse-field.ts); the fenced client lives in
// fenced-code/fenced-code-collapse.ts.
//
// Block widgets MUST come from a StateField — CodeMirror throws on a ViewPlugin
// `block: true` Decoration.replace (see CLAUDE.md block-widget invariant).
//
// Display-only: decorations only, never a document change → byte-identical round-trip.
//
// Publishes to NEITHER zone facet (quollBlockReplaceZones / quollSyntaxExclusionZones).
// Decision 7: blockquote-reveal's inline `>` hide replace (decorations/blockquote-reveal.ts)
// starts at the same offset as this field's block replace on the first concealed line;
// CodeMirror emits the block replace as the point and swallows the inline one, so no
// exclusion is needed — do not add one.

import { defineLineCollapseField, type LineCollapseSpec } from "../collapse/line-collapse-field.js";
import { blockquoteCollapseTarget } from "./blockquote-collapse-state.js";
import { BlockquoteCollapseToggleWidget } from "./blockquote-collapse-widget.js";
import type { CalloutType } from "./callout.js";

export const blockquoteCollapseSpec: LineCollapseSpec<CalloutType | null> = {
  ...blockquoteCollapseTarget,
  makeWidget: ({ key, expanded, hiddenCount, extra }) =>
    new BlockquoteCollapseToggleWidget(key, expanded, hiddenCount, extra),
  // Always full: a top-level quote's existence/extent can change through edits nowhere near
  // it (lazy-run split, list indent, link reference definition), and every bounded
  // predicate tried in review leaked a case. "Full" here is a walk over Document's DIRECT
  // children only — measured, see PERF-log (2026-10-08) and the plan's Decision 3.
  docChangePlan: () => "full",
};

export const blockquoteCollapseField = defineLineCollapseField(blockquoteCollapseSpec, "bounded");
