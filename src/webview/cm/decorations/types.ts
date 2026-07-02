// Public contract every inline-decoration provider (reveal or marker)
// implements. The orchestrator (ViewPlugin in `orchestrator.ts`) calls
// build(ctx) once per ViewUpdate that signals a rebuild trigger (doc /
// viewport / selection / parser-completion), passing a snapshot context
// that excludes the EditorView itself — providers are pure functions of
// (tree, selection, visibleRanges) and have no surface to dispatch or
// touch the DOM (review fix #8). Block-widget decorations are out of
// scope for this contract (review fix #1): they ship as their own
// StateField extensions and publish exclusion ranges via the
// `quollBlockReplaceZones` facet defined in `orchestrator.ts`.
//
// `Tree` is derived from `syntaxTree`'s return type rather than imported
// from `@lezer/common` directly (review fix #12). `@lezer/common` is a
// transitive-only dep that pnpm does not hoist (verified: `find
// node_modules/@lezer/common` empty; `.npmrc` `public-hoist-pattern`
// covers `@types/*` only); declaring it as a direct dep would violate
// the repo's supply-chain default-deny. The C2 `lezer-url-walker.ts`
// chose the same alias strategy for the same reason.

import type { syntaxTree } from "@codemirror/language";
import type { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

type Tree = ReturnType<typeof syntaxTree>;

export type BuildContext = {
  /** Snapshot state for this build. */
  state: EditorState;
  /** Current selection. Multi-cursor: `selection.ranges` carries every caret. */
  selection: EditorSelection;
  /** Visible ranges; providers walk the syntax tree only across these. */
  visibleRanges: readonly { from: number; to: number }[];
  /** The Lezer tree of `state`, computed once by the orchestrator and shared
   *  across providers so each one does not re-call syntaxTree(). */
  tree: Tree;
};

export type DecorationProvider = {
  /** Pure function of (tree, selection, viewport). Must return Decoration.none
   *  when the visible ranges contain no candidate constructs — never null. */
  build(ctx: BuildContext): DecorationSet;
};
