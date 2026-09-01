// Rendered-text → source-offset map for ONE rendered table cell, plus the
// registry that ties a map to the cell element it describes.
//
// Why this exists: a table cell's DOM is a rendering of its Markdown source
// (`**bold**` → `bold`), so a DOM character offset is NOT addable to the cell's
// source offset. cell-point.ts used to decide "addable" by comparing LENGTHS,
// which forced every cell holding any inline markup onto the "no exact mapping"
// path AND rested on an unwritten contract (no construct may render longer than
// its source) that a future construct could break silently. The renderer
// already knows the exact answer — the inline IR gives every text run and leaf
// its source span — so cell-render.ts emits this map in the SAME pass that
// emits the DOM, and cell-point.ts consumes it. The renderer is the mapping
// authority; nothing re-derives it.

// Two of the three offset spaces this module's header warns about, made
// distinct at compile time. (The third — the ABSOLUTE document space — lives in
// cell-point.ts: this module neither produces nor consumes it, and putting it
// here would give the map a vocabulary it never speaks.) Same idiom as
// `OpenLineOffset` (fenced-code-node.ts) and `AllowlistedUrl`
// (src/markdown/url-allowlist.ts): a `unique symbol` brand plus a NAMED
// constructor, so entering a space is a grep-discoverable line.
//
// What the brands buy: a value from one space can no longer be passed where
// another is expected. What they deliberately do NOT do: reject `a + b`. TS
// types arithmetic on number-assignable operands as plain `number`, so a
// cross-space sum is caught at its CONSUMPTION (the sum is no longer branded),
// not at the `+`. That is why cell-point.ts's one legitimate crossing has to
// say `asAbsoluteOffset(...)` out loud, and why every other crossing fails.
//
// The constructors are casts, not guards — the brand is a marker (the
// AllowlistedUrl precedent's wording). Runtime safety still comes from
// `stampedOffset`'s digit gate and cell-point.ts's `Number.isSafeInteger`
// re-check, both unchanged, and both sit directly beside the mint they feed.

declare const renderedOffsetBrand: unique symbol;
/** An index into ONE cell's rendered text — what a DOM `Range` measures. */
export type RenderedOffset = number & { readonly [renderedOffsetBrand]: true };

declare const cellSourceOffsetBrand: unique symbol;
/** An offset into ONE cell's raw Markdown source, relative to the cell's
 *  content start — the space every offset in a `CellSourceMap` lives in. */
export type CellSourceOffset = number & { readonly [cellSourceOffsetBrand]: true };

/** THE constructor of a {@link RenderedOffset}. */
export function asRenderedOffset(value: number): RenderedOffset {
  return value as RenderedOffset;
}

/** THE constructor of a {@link CellSourceOffset}. */
export function asCellSourceOffset(value: number): CellSourceOffset {
  return value as CellSourceOffset;
}

/** One run of rendered characters mapping 1:1 onto source characters. Adjacent
 *  runs are NOT merged — a text node and a following inert construct stay
 *  separate runs, so "maximal run" would be a lie; the boundary lookup's
 *  equality check makes a junction between two touching runs resolve exactly
 *  anyway.
 *
 *  There is deliberately NO rendered-position field: a run's start in the
 *  cell's rendered text is the running sum of the preceding runs' lengths
 *  (`to - from` each), which `sourceOffsetAt` accumulates as it scans. Storing
 *  it would let the TYPE express an inter-run gap or overlap — a shape neither
 *  producer emits and every consumer would misread. This does NOT make every
 *  malformed map unrepresentable (a run list whose TOTAL length disagrees with
 *  the rendered text still is, which is why `renderCellWithMap` keeps its
 *  tiling check) — it removes exactly the class that was pure duplication.
 *
 *  Every offset here is CELL-CONTENT-RELATIVE (`+ cellFrom` at lookup) because
 *  `TableBlockWidget.stampRow` re-points `data-cell-from`/`data-cell-to` on a
 *  pure positional shift WITHOUT re-rendering — an absolute map would go stale
 *  exactly there.
 *
 *  `from`/`to` bracket the rendered characters themselves (`to - from` IS the
 *  run's rendered length); `outerFrom`/`outerTo` additionally cover the markup
 *  owned by the construct the run came from (`**`, `[`…`](url)`, a backtick
 *  pair, an escape's backslash) — what a boundary sitting AT the run's edge
 *  expands to, so selecting all of `bold` in `**bold**` yields `**bold**` and
 *  the selection still round-trips to the same rendered content. */
export interface CellSourceRun {
  readonly from: CellSourceOffset;
  readonly to: CellSourceOffset;
  readonly outerFrom: CellSourceOffset; // <= from
  readonly outerTo: CellSourceOffset; // >= to
}

/** The map for one cell. Both extra fields are load-bearing TWICE over. They
 *  bound and terminate the lookup in `sourceOffsetAt` below — `renderedText`
 *  for the input range and the end-of-text boundary, `sourceLength` for the
 *  empty-runs and end-of-source exactness tests — AND they are the staleness
 *  check in cell-point.ts: a map is only trustworthy while BOTH the source it
 *  was built from and the DOM it produced are still the ones on screen. Length
 *  equality alone would let a same-length stale map through, which is the very
 *  failure mode this module replaces. */
export interface CellSourceMap {
  readonly runs: readonly CellSourceRun[];
  /** Length of the raw cell source the map was built from — equivalently the
   *  END offset of that source, which is what the end-of-text arm returns. */
  readonly sourceLength: CellSourceOffset;
  /** The text the map describes — compared against the cell's live
   *  `textContent`, the one check a coincidence of lengths cannot fool. */
  readonly renderedText: string;
}

// Module-private registry. A WeakMap rather than a DOM attribute: it is not
// forgeable from the DOM (no new trust boundary, no parser — contrast the
// `data-cell-from` stamps, which `stampedOffset` has to police), and a
// discarded cell takes its entry with it.
//
// "The renderer is the mapping authority" is a CONVENTION, not a type: the
// interface above is structurally satisfiable by any object with the right
// fields, and `setCellSourceMap` takes one from anywhere. What actually holds
// it is that `renderCellInto` is the only supported way to fill a cell and it
// registers the map it just produced. Nothing here VERIFIES it: `sourceOffsetAt`
// checks `within` and then trusts every number in the map unconditionally, so a
// bad map yields a bad answer. The design does not rest on that, because its
// caller (cell-point.ts) re-gates the answer with `Number.isSafeInteger` before
// dispatching it.
const registry = new WeakMap<Element, CellSourceMap>();

export function setCellSourceMap(cell: Element, map: CellSourceMap): void {
  registry.set(cell, map);
}

export function getCellSourceMap(cell: Element): CellSourceMap | null {
  return registry.get(cell) ?? null;
}

/** Relative source offset for the rendered boundary `within`, or `null` when
 *  there is no exact answer.
 *
 *  A rendered boundary sits either INSIDE a run — exact, and the whole point of
 *  this module — or BETWEEN two runs. Between two runs the source partitions
 *  into `[ closers ][ skipped ][ openers ]`: the left run's closing markup, any
 *  construct that renders NO text, and the right run's opening markup. Closers
 *  belong to what the pointer just left and openers to what it is entering, so
 *  both collapse onto ONE position — `L.outerTo` from the left, `R.outerFrom`
 *  from the right — and for every construct that renders text those two
 *  coincide. That shared value IS the exact answer.
 *
 *  Skipped source is the exception, and it is why a boundary cannot be a PAIR:
 *  an `<img>` renders zero characters, so the positions on BOTH sides of it
 *  measure the SAME rendered offset (probed in happy-dom: `a<img>c` gives
 *  `Range.toString() === "a"` for the point before and after the image).
 *  Nothing in a rendered offset can prove the pointer crossed it, so treating
 *  the gap as a range would let a 4px wiggle beside an image select it. When
 *  `L.outerTo !== R.outerFrom` we therefore answer `null` — the same "no exact
 *  mapping" the old length gate gave for such cells, which `dragRange`'s
 *  existing outward snap already handles. */
export function sourceOffsetAt(
  map: CellSourceMap,
  within: RenderedOffset
): CellSourceOffset | null {
  const { runs, renderedText, sourceLength } = map;
  if (!Number.isInteger(within) || within < 0 || within > renderedText.length) {
    return null;
  }
  if (runs.length === 0) {
    // No run at all. The only cell whose single boundary is still exact is one
    // that renders nothing FROM nothing; a cell whose whole source rendered
    // invisibly (`![i](p.png)`) has a boundary that could be either side of it.
    return within === 0 && sourceLength === 0 ? sourceLength : null;
  }
  if (within === renderedText.length) {
    // End of the rendered text. Exact only when the last run's closers reach
    // the end of the source — trailing skipped source (a live image after the
    // last text) leaves a gap the boundary cannot resolve.
    const last = runs[runs.length - 1];
    return last.outerTo === sourceLength ? sourceLength : null;
  }
  // The current run's start in the rendered text: accumulated as this scan
  // goes, never stored on the run — see `CellSourceRun` above for why the
  // field is absent.
  let rendered = 0;
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const runLength = run.to - run.from;
    if (within > rendered && within < rendered + runLength) {
      // The one arithmetic crossing INSIDE the map's own space: a rendered
      // delta added to a source offset is a source offset, which the run's
      // 1:1 length (`to - from` IS its rendered length) is what makes true.
      return asCellSourceOffset(run.from + (within - rendered));
    }
    if (within === rendered) {
      if (i === 0) {
        // Leading skipped source (`![i](p.png)a`) leaves the first run's
        // openers short of the cell start, and the boundary is then ambiguous
        // in exactly the same way an interior one is.
        return run.outerFrom === 0 ? run.outerFrom : null;
      }
      const prev = runs[i - 1];
      return prev.outerTo === run.outerFrom ? prev.outerTo : null;
    }
    rendered += runLength;
  }
  // Unreachable while runs tile the rendered text contiguously. Both producers
  // satisfy that: `emitRun` (cell-render.ts) advances the cursor by exactly the
  // run's length and its caller publishes NO runs if the total still misses the
  // rendered length, and `renderCellSafely`'s fallback map is a single identity
  // run over verbatim source. Kept as the fail-closed answer rather than a
  // throw: this runs inside a DOM listener.
  return null;
}
