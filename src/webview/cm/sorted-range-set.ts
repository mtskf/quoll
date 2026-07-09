import { type RangeSet, RangeSetBuilder, type RangeValue } from "@codemirror/state";

/**
 * Build a `RangeSet` from items that are NOT already in the order
 * `RangeSetBuilder.add` requires.
 *
 * `RangeSetBuilder.add(from, to, value)` mandates that calls arrive sorted by
 * `from`, then by `value.startSide` for an equal `from`; it throws otherwise
 * (see `@codemirror/state`'s `RangeSetBuilder.addInner` — the throw inspects
 * `from` and `startSide`, never `to`). Several collection passes cannot honour
 * that by construction — a Lezer pre-order DFS visits a nested child mark
 * between its parent's open and close marks, a multi-`visibleRange` walk can
 * surface a lower `from` from a later range, and `Map` iteration follows
 * insertion order. Each such call site used to keep its own
 * `out.sort((a, b) => a.from - b.from || a.to - b.to)` + fresh-builder loop
 * with a copy of this rationale; this helper owns that idiom once.
 *
 * `project` maps each item to a `[from, to, value]` triple. The sort is stable
 * (ES2019+ `Array.prototype.sort`), by `from` then `to`. `from` is the builder
 * requirement above (every call site uses a single decoration kind, so
 * `startSide` is uniform and the `from` order also satisfies the `startSide`
 * tie-break). The `to` tie-break mirrors what the original call sites sorted by,
 * kept so the pre-`add` order is self-sufficient rather than relying on
 * `RangeSet`'s internal re-sort of equal-`from` ranges — it is not separately
 * observable through the returned set (that re-sort already orders equal-`from`
 * ranges by `to`), so no test pins it in isolation. Stability keeps items with
 * an identical `[from, to]` in input order, so the emitted set is deterministic
 * regardless of how the pass enqueued equal-span ranges.
 */
export function buildSortedRangeSet<T, V extends RangeValue>(
  items: Iterable<T>,
  project: (item: T) => readonly [from: number, to: number, value: V]
): RangeSet<V> {
  const triples = Array.from(items, project);
  triples.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const builder = new RangeSetBuilder<V>();
  for (const [from, to, value] of triples) {
    builder.add(from, to, value);
  }
  return builder.finish();
}
