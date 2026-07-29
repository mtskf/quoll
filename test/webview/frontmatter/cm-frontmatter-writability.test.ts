// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { isWritable, writabilityFacets } from "../../../src/webview/cm/frontmatter/reveal-state.js";

// Pins the writability contract PR #279 fixed and this change mechanized:
// `isWritable()` (the predicate) and `writabilityFacets` (the
// reactive dependency list spread into compute() in frontmatter-field.ts) derive
// from ONE source, so they cannot drift out of sync. These tests go red if the
// polarity of either facet is inverted OR if the reactive dependency list stops
// covering a facet the predicate reads (the stale-aria-description regression).

function stateWith(opts: { readOnly: boolean; editable: boolean }): EditorState {
  return EditorState.create({
    extensions: [EditorState.readOnly.of(opts.readOnly), EditorView.editable.of(opts.editable)],
  });
}

describe("frontmatter writability contract", () => {
  it("isWritable is true only when readOnly=false AND editable=true", () => {
    expect(isWritable(stateWith({ readOnly: false, editable: true }))).toBe(true);
    expect(isWritable(stateWith({ readOnly: true, editable: true }))).toBe(false);
    expect(isWritable(stateWith({ readOnly: false, editable: false }))).toBe(false);
    expect(isWritable(stateWith({ readOnly: true, editable: false }))).toBe(false);
  });

  it("writabilityFacets covers exactly the facets isWritable gates on", () => {
    // Reactive-dependency completeness: the collapsed widget's aria-description
    // only recomputes when a facet in this list changes, so it MUST list every
    // facet isWritable reads — no more, no fewer.
    expect(writabilityFacets).toContain(EditorState.readOnly);
    expect(writabilityFacets).toContain(EditorView.editable);
    expect(writabilityFacets).toHaveLength(2);
  });

  it("every facet in writabilityFacets actually gates isWritable (no dead entries)", () => {
    // Drive the real writabilityFacets list: from a fully-writable baseline,
    // flipping ANY one listed facet away from its writable value must turn
    // isWritable false. A facet listed in writabilityFacets that isWritable
    // ignored (a dead entry) would leave isWritable true on that facet's flip.
    const base = stateWith({ readOnly: false, editable: true });
    expect(isWritable(base)).toBe(true);
    for (const target of writabilityFacets) {
      const flipped = EditorState.create({
        extensions: writabilityFacets.map((facet) =>
          facet.of(facet === target ? !base.facet(facet) : base.facet(facet))
        ),
      });
      expect(isWritable(flipped)).toBe(false);
    }
  });
});
