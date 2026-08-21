// Fixtures shared by the `cm-table-cell-render-*.test.ts` suites that assert on
// rendered markup — urls, emphasis and text. (The clicks suite dispatches events
// against the returned nodes and needs neither; inline-ir touches no DOM at all,
// and render-map reads innerHTML off the real cell `renderCellInto` populated
// rather than serialising a detached Node[].) Extracted rather than copied per
// file because the tooltip strip had 11 occurrences before the split, spread
// over three files-to-be: one definition is one place to fix when the tooltip's
// text changes. Not a test file itself (no `.test.ts` suffix), mirroring
// helpers/widget-fixtures.ts.

/** Serialise rendered cell nodes to markup.
 *
 *  Appends CLONES: `appendChild` would move the caller's nodes into this
 *  throwaway root, leaving the array it still holds detached from whatever it
 *  was. No caller reads its nodes after serialising them today, so this changes
 *  no result — it removes the trap a shared serialiser would otherwise set for
 *  the first test that wants to check markup and then dispatch an event. */
export function html(nodes: Node[]): string {
  const root = document.createElement("div");
  for (const n of nodes) {
    root.appendChild(n.cloneNode(true));
  }
  return root.innerHTML;
}

/** `html`, minus the discoverability tooltip, whose text resolves "Cmd" vs
 *  "Ctrl" at module load from `navigator.platform` — a structural snapshot that
 *  kept it would pass or fail by platform.
 *
 *  Matched by its exact shape rather than as "any title attribute": the tooltip
 *  is the only title cell-render.ts sets today, and a broad strip would silently
 *  erase a meaningful one added later, leaving the snapshot green while the
 *  attribute went unpinned by anything.
 *
 *  Stripping it here does NOT leave the tooltip unpinned. That links and
 *  autolinks both carry one, and that it names the modifier, is asserted off
 *  `a.title` in cm-table-cell-render-clicks.test.ts. */
export function htmlWithoutTooltip(nodes: Node[]): string {
  return html(nodes).replace(/ title="(?:Cmd|Ctrl)\+click to open"/g, "");
}
