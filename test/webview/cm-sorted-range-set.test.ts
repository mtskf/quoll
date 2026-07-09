import { type RangeSet, RangeSetBuilder, type RangeValue } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { buildSortedRangeSet } from "../../src/webview/cm/sorted-range-set.js";

/** Read a RangeSet back to `[from, to, value]` triples in stored order. */
function entries<V extends RangeValue>(set: RangeSet<V>): Array<[number, number, V]> {
  const out: Array<[number, number, V]> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    out.push([iter.from, iter.to, iter.value]);
    iter.next();
  }
  return out;
}

describe("buildSortedRangeSet", () => {
  it("sorts out-of-order items by `from` before building", () => {
    // RangeSetBuilder.add throws on a decreasing `from`; feeding this input
    // straight to a builder would throw, so a green build proves the sort ran.
    const a = Decoration.mark({ class: "a" });
    const b = Decoration.mark({ class: "b" });
    const c = Decoration.mark({ class: "c" });
    const set = buildSortedRangeSet(
      [
        { at: 20, deco: c },
        { at: 5, deco: a },
        { at: 12, deco: b },
      ],
      (m) => [m.at, m.at + 1, m.deco]
    );
    expect(entries(set)).toEqual([
      [5, 6, a],
      [12, 13, b],
      [20, 21, c],
    ]);
  });

  it("returns an empty RangeSet for an empty iterable", () => {
    // Every migrated call site can legitimately collect zero items (no matching
    // syntax in the visible range), so the zero-item path is a real boundary.
    const set = buildSortedRangeSet<{ deco: Decoration }, Decoration>([], () => [
      0,
      0,
      Decoration.mark({ class: "unused" }),
    ]);
    expect(entries(set)).toEqual([]);
  });

  // NOTE: there is deliberately no "breaks ties on `to`" test. The comparator's
  // `to` tie-break only orders the pre-`add` sequence; RangeSet re-sorts
  // equal-`from` ranges by `to` on read (verified against @codemirror/state), so
  // the term has no separately observable effect on the returned set and any
  // output-level assertion for it would be vacuous. The stable-sort test below
  // pins the determinism that IS observable.

  it("is a stable sort — identical [from,to] items keep input order", () => {
    // A stable tie-break makes the output deterministic regardless of how the
    // collection pass happened to enqueue equal-span decorations.
    const first = Decoration.mark({ class: "first" });
    const second = Decoration.mark({ class: "second" });
    const forward = buildSortedRangeSet([{ deco: first }, { deco: second }], (m) => [3, 3, m.deco]);
    // Reversing the input reverses the output — order follows input, not identity.
    const reversed = buildSortedRangeSet([{ deco: second }, { deco: first }], (m) => [
      3,
      3,
      m.deco,
    ]);
    expect(entries(forward).map((e) => e[2])).toEqual([first, second]);
    expect(entries(reversed).map((e) => e[2])).toEqual([second, first]);
  });

  it("accepts any Iterable — Map.entries() matches the array form", () => {
    // block-style.ts feeds `Map.entries()`; it must produce the same RangeSet
    // as the equivalent array, exercising the same sort + tie-break path.
    const x = Decoration.line({ class: "x" });
    const y = Decoration.line({ class: "y" });
    const project = ([from, deco]: [number, Decoration]): [number, number, Decoration] => [
      from,
      from,
      deco,
    ];
    const fromMap = buildSortedRangeSet(
      new Map([
        [40, y],
        [10, x],
      ]).entries(),
      project
    );
    const fromArray = buildSortedRangeSet(
      [
        [40, y],
        [10, x],
      ] as Array<[number, Decoration]>,
      project
    );
    expect(entries(fromMap)).toEqual(entries(fromArray));
    expect(entries(fromMap)).toEqual([
      [10, 10, x],
      [40, 40, y],
    ]);
  });

  it("matches a hand-rolled sort-then-build over the same data", () => {
    const items = [
      { from: 30, to: 33 },
      { from: 8, to: 9 },
      { from: 8, to: 12 },
      { from: 21, to: 25 },
    ];
    const deco = Decoration.mark({ class: "m" });
    const viaHelper = entries(buildSortedRangeSet(items, (m) => [m.from, m.to, deco]));

    const sorted = [...items].sort((p, q) => p.from - q.from || p.to - q.to);
    const builder = new RangeSetBuilder<Decoration>();
    for (const m of sorted) {
      builder.add(m.from, m.to, deco);
    }
    const viaBuilder = entries(builder.finish());

    expect(viaHelper).toEqual(viaBuilder);
  });
});
