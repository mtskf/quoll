import { type RangeSet, RangeSetBuilder, type RangeValue } from "@codemirror/state";

/**
 * Build a `RangeSet` from items that are NOT already in the order
 * `RangeSetBuilder.add` requires.
 *
 * `RangeSetBuilder.add(from, to, value)` mandates a non-decreasing `from`
 * across calls (and, for an equal `from`, a non-decreasing `to`); it throws
 * otherwise. Several collection passes cannot honour that by construction — a
 * Lezer pre-order DFS visits a nested child mark between its parent's open and
 * close marks, a multi-`visibleRange` walk can surface a lower `from` from a
 * later range, and `Map` iteration follows insertion order. Each such call site
 * used to keep its own `out.sort((a, b) => a.from - b.from || a.to - b.to)` +
 * fresh-builder loop with a copy of this rationale; this helper owns that idiom
 * once.
 *
 * `project` maps each item to a `[from, to, value]` triple. The sort is by
 * `from` then `to` and is stable (ES2019+ `Array.prototype.sort`), so items
 * with an identical `[from, to]` keep their input order — the decoration
 * overlap order the call sites depend on stays deterministic and independent of
 * how the pass happened to enqueue equal-span ranges.
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
