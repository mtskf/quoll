// Arbitration + a ViewPlugin that runs registered providers and exposes the
// merged DecorationSet.
//
// arbitrate() is a pure function (no EditorView) — the testable contract
// every downstream widget slice (C4b, C5, C6b–d, C7) plugs into. C4a's
// ViewPlugin handles INLINE decorations only (review fix #1, CodeMirror
// forbids view-plugin-sourced block widgets). Block widgets land in their
// own StateField extensions and publish exclusion ranges via the
// `quollBlockReplaceZones` facet below.

import { syntaxTree } from "@codemirror/language";
import { type Extension, Facet, RangeSet } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { perfNow, perfRecord } from "../../../shared/perf.js";
import type { BuildContext, DecorationProvider } from "./types.js";

/** Block-widget slices ship their own StateField extensions and contribute the
 *  widget's range to this facet. The orchestrator reads the facet at build time
 *  and treats every contributed range as an exclusion zone (inline decorations
 *  dropping out). Contributors should keep the per-extension array sorted by
 *  `from`; the orchestrator does not re-sort.
 *
 *  Live contributors: C6b–d table-field.ts and C7 image-field.ts. (C8b
 *  frontmatter contributes to quollSyntaxExclusionZones below, NOT here.)
 *  C4a ships NO contributors; an integration test registers a synthetic one
 *  to exercise the filter so new slices plug in without rediscovering the
 *  contract. */
export const quollBlockReplaceZones = Facet.define<
  readonly { from: number; to: number }[],
  readonly { from: number; to: number }[]
>({
  combine: (sources) => sources.flat(),
});

/** De-markdown zones that suppress Quoll's WYSIWYG inline decorations
 *  REGARDLESS of whether a block widget is shown. SEPARATE from
 *  `quollBlockReplaceZones` (shown-widget-only; it also drives
 *  blockZoneArrowKeymap navigation): the frontmatter span contributes here so
 *  its inline marks drop both when shown AND when revealed as raw source. The
 *  orchestrator unions both facets for inline arbitration; the standalone
 *  listHangIndent ViewPlugin reads THIS facet for line-decoration exclusion
 *  (point-containment semantics, see shared.ts). */
export const quollSyntaxExclusionZones = Facet.define<
  readonly { from: number; to: number }[],
  readonly { from: number; to: number }[]
>({
  combine: (sources) => sources.flat(),
});

export type ArbitrateInput = {
  /** Joined inline decorations from every provider (marker + reveal). */
  inline: DecorationSet;
  /** Exclusion zones (the union of quollBlockReplaceZones + quollSyntaxExclusionZones). */
  exclusionZones: readonly { from: number; to: number }[];
};

/** Drop inline decorations whose range OVERLAPS any exclusion zone.
 *  Touching (shared endpoint, no interior overlap) is NOT an overlap. */
export function arbitrate(input: ArbitrateInput): DecorationSet {
  if (input.exclusionZones.length === 0) {
    return input.inline;
  }
  const zones = input.exclusionZones;
  return input.inline.update({
    filter: (from, to) => {
      for (const z of zones) {
        // Half-open interval overlap: [a, b) and [c, d) overlap iff a < d && c < b.
        if (from < z.to && z.from < to) {
          return false;
        }
      }
      return true;
    },
  });
}

// --- ViewPlugin: run providers across visibleRanges, hold the merged set ---

/** Build the extension entry that registers the orchestrator ViewPlugin
 *  with the supplied providers. Provider ARRAY identity is captured at
 *  factory-call time — pass a stable closure (e.g. module-level) so the
 *  ViewPlugin doesn't see a fresh provider list every render. */
export function createSyntaxReveal(providers: readonly DecorationProvider[]): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = computeMerged(view, providers);
      }
      update(u: ViewUpdate): void {
        // Rebuild on triggers that can change decoration ranges/spec:
        //   - docChanged: tree edges moved
        //   - viewportChanged: visibleRanges differ → providers must re-walk
        //   - selectionSet: reveal/hide flips
        //   - syntaxTree identity changed: async parser completion finished
        //     (review fix #2, Codex Conf 95) — without this clause a large
        //     doc whose initial parse lags renders decoration-less until
        //     the user types or scrolls.
        //   - quollBlockReplaceZones facet identity changed (Codex H2):
        //     future block-widget slices (C5/C6/C7) publish exclusion ranges
        //     via a StateField → facet contributor. The facet contents can
        //     change without touching doc/viewport/selection/tree, and
        //     without this clause the orchestrator would leave stale inline
        //     decorations inside a newly-claimed block zone until a
        //     coincidental trigger fires.
        // A no-op update (annotation-only with none of the above moving)
        // is dropped — same-input output wastes a tick.
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.startState.facet(quollBlockReplaceZones) !== u.state.facet(quollBlockReplaceZones) ||
          u.startState.facet(quollSyntaxExclusionZones) !== u.state.facet(quollSyntaxExclusionZones)
        ) {
          this.decorations = computeMerged(u.view, providers);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

function computeMerged(view: EditorView, providers: readonly DecorationProvider[]): DecorationSet {
  const buildStart = QUOLL_PERF ? perfNow() : 0;
  const tree = syntaxTree(view.state);
  const ctx: BuildContext = {
    state: view.state,
    selection: view.state.selection,
    visibleRanges: view.visibleRanges,
    tree,
  };
  let inline: DecorationSet = Decoration.none;
  for (const p of providers) {
    inline = RangeSet.join([inline, p.build(ctx)]);
  }
  const blockZones = view.state.facet(quollBlockReplaceZones);
  const syntaxZones = view.state.facet(quollSyntaxExclusionZones);
  const exclusionZones =
    syntaxZones.length === 0
      ? blockZones
      : blockZones.length === 0
        ? syntaxZones
        : [...blockZones, ...syntaxZones];
  const result = arbitrate({ inline, exclusionZones });
  if (QUOLL_PERF) {
    perfRecord("webview:decoration-build", perfNow() - buildStart);
  }
  return result;
}
