// Provenance: this reveal/widget layer is independently implemented; the
// live-preview "reveal source under the caret" behaviour was referenced from
// ixora (Apache-2.0) / Atomic Editor (MIT) for behaviour only — no source is
// vendored or adapted. See root NOTICE.
//
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

/** Failure signatures already logged, per provider.
 *
 *  Keyed by provider identity AND normalised message rather than identity
 *  alone: identity-only deduping would silence a provider's next, unrelated
 *  failure for the rest of the session once it had failed once — recreating
 *  this guard's own failure mode one layer down. `WeakMap` so
 *  test-constructed providers impose no retention.
 *
 *  ⚠️ This buckets by MESSAGE, which is a proxy for "distinct failure", not a
 *  synonym: two different bugs that both surface as
 *  `Cannot read properties of undefined` collide and the second is dropped.
 *  Keying on the throw site (stack frame) would separate them, at the cost of
 *  parsing stacks that non-`Error` throws do not have. The message proxy is
 *  the deliberate middle: strictly better than identity-only, far cheaper than
 *  stack parsing, and the first log of each signature carries the full error
 *  (stack included) for the developer who actually reads it. */
const loggedBuildFailures = new WeakMap<DecorationProvider, Set<string>>();

/** Cap per provider. Messages are provider-authored and not a finite set, so
 *  the signature set needs a bound regardless of normalisation. */
const MAX_LOGGED_SIGNATURES_PER_PROVIDER = 5;

/** Digit runs collapse so that ONE bug reported at many positions counts as one
 *  signature. Without this the cap defeats itself: a `RangeError` from
 *  `doc.lineAt(pos)` embeds the position, so a failure that follows the caret
 *  would mint a fresh signature per keystroke and exhaust the cap within
 *  seconds — silencing the provider before any unrelated second failure could
 *  ever log.
 *
 *  Must be TOTAL: `err.message` and `String(err)` both run user-supplied code
 *  (a getter, a `toString`) and can throw, and a value with no primitive
 *  conversion (`Object.create(null)`) makes `String()` throw on its own. */
function failureSignature(err: unknown): string {
  try {
    return String(err instanceof Error ? err.message : err).replace(/\d+/g, "#");
  } catch {
    return "<unrepresentable error>";
  }
}

function logProviderFailure(provider: DecorationProvider, index: number, err: unknown): void {
  let seen = loggedBuildFailures.get(provider);
  if (!seen) {
    seen = new Set();
    loggedBuildFailures.set(provider, seen);
  }
  const signature = failureSignature(err);
  if (seen.has(signature) || seen.size >= MAX_LOGGED_SIGNATURES_PER_PROVIDER) {
    return;
  }
  seen.add(signature);
  console.error(
    "[quoll] decoration provider build() failed; its decorations are skipped for this build. " +
      `Further distinct failures from this provider are logged up to ${MAX_LOGGED_SIGNATURES_PER_PROVIDER} signatures.`,
    { providerIndex: index },
    err
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
  // CONTAINMENT (do not remove): every provider runs inside the ONE orchestrator
  // ViewPlugin, and CodeMirror's PluginInstance.update catches a throw from
  // either the constructor or update path, calls logException, then
  // deactivate()s the plugin PERMANENTLY (spec/value nulled, no reconstruction
  // path). One bad provider would therefore revert EVERY inline decoration —
  // headings, emphasis, links, tables, images — to raw Markdown until the user
  // reloads the window, with only a console.error they will never see. So a
  // failing provider degrades to "contributes nothing this build" and the rest
  // stay live. `inline` is reassigned only on the success path, so a failure
  // preserves what earlier providers already contributed. The provider keeps
  // being called on later builds, so a transient failure self-heals.
  //
  // SCOPE, precisely: this contains a throw from build() and a return value
  // that is not a RangeSet. It does NOT contain a provider that returns a
  // well-formed RangeSet carrying a decoration a ViewPlugin may not emit — a
  // block decoration, or a replace across a line break. CodeMirror rejects
  // those later, in TileUpdate.emit ("Block decorations may not be specified
  // via plugins"), on the escape path described below. That gap predates this
  // guard and closing it would need a per-build scan of every emitted range on
  // a per-keystroke path; the standing rule that block widgets are StateFields,
  // never ViewPlugins, is what keeps it unreachable in practice.
  //
  // ⚠️ Do NOT push try/catch down into the providers instead. A totality
  // regression inside a provider must stay a RED TEST, not become a silently
  // missing decoration — see cm/link-target.ts's "TOTALITY IS A HARD CONTRACT"
  // header and cm/link-resolve.ts's buildSlugIndex guard. Containment makes
  // such a regression QUIETER, which raises the value of those direct unit
  // matrices rather than lowering it.
  for (let index = 0; index < providers.length; index++) {
    // Indexed loop, not `.entries()`: this runs on every keystroke and caret
    // move, and `.entries()` allocates an iterator plus one tuple per provider
    // per build purely to carry an index used only in a log message.
    const p = providers[index];
    try {
      const built = p.build(ctx);
      // Validate BEFORE the join: RangeSet.join([acc, built]) starts from
      // `result = built` and only enters its merge loop while
      // `acc != RangeSet.empty`, so with an empty accumulator a null/undefined
      // return (or a bare Range[]) is passed through UNTHROWN. That poisons
      // `inline`, and then either the NEXT provider's join throws (blaming an
      // innocent provider and losing its output too) or `this.decorations`
      // reaches CodeMirror, which throws while diffing the decoration set in
      // DocView.update → RangeSet.compare. That path is NOT inside
      // PluginInstance.update's try, so it does not even reach the
      // deactivate() above — it escapes view.dispatch() into our own caller,
      // aborting the update mid-flight. Strictly worse than deactivation.
      if (!(built instanceof RangeSet)) {
        throw new TypeError(
          `DecorationProvider.build() must return a DecorationSet, got ${built === null ? "null" : typeof built}`
        );
      }
      inline = RangeSet.join([inline, built]);
    } catch (err) {
      // The REPORTING path must not be able to escalate a contained failure
      // into the very crash this guard prevents. `String(err)` / `err.message`
      // run user code, a non-object provider entry would make WeakMap.set
      // throw, and console.error is host-supplied. Failing to log is a
      // diagnostic loss; failing to contain is a dead editor.
      try {
        logProviderFailure(p, index, err);
      } catch {
        // Intentionally empty — see above.
      }
    }
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
