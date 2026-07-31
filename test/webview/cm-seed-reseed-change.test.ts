import type { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { commonAffixLengths } from "../../src/shared/minimal-span.js";
import { computeReseedChange, splitToCmText } from "../../src/webview/cm/seed.js";

// Reference span derived from the shared string core (the host write path's
// authoritative, fuzz-verified scan). The Text-iterator scan inside
// computeReseedChange must stay byte-for-byte in lockstep with this — the
// parity test below is the mechanism that catches drift if either side's
// prefix/suffix-cap logic changes.
function deriveViaStringCore(
  oldDoc: Text,
  newDoc: Text
): { from: number; to: number; insert: string } {
  const oldStr = oldDoc.toString();
  const newStr = newDoc.toString();
  const { prefix, suffix } = commonAffixLengths(oldStr, newStr);
  return {
    from: prefix,
    to: oldStr.length - suffix,
    insert: newStr.slice(prefix, newStr.length - suffix),
  };
}

// Apply the computed single-span change to `old` and assert it reproduces
// `next` in CM's LF-internal coordinates — the contract the reseed relies on.
function applyChange(old: Text, change: { from: number; to: number; insert: Text }): string {
  const s = old.toString();
  return s.slice(0, change.from) + change.insert.toString() + s.slice(change.to);
}

describe("computeReseedChange — minimal single-span reseed change", () => {
  it("a one-char middle edit produces a change spanning only that char", () => {
    const old = splitToCmText("# Title\n\nalpha\nbravo\ncharlie");
    const next = splitToCmText("# Title\n\nalpha\nBravo\ncharlie"); // 'b' -> 'B'
    const change = computeReseedChange(old, next);
    expect(change.to - change.from).toBe(1);
    expect(change.insert.toString()).toBe("B");
    expect(applyChange(old, change)).toBe(next.toString());
  });

  it("an append leaves the common prefix untouched (from at old end)", () => {
    const old = splitToCmText("line one\nline two");
    const next = splitToCmText("line one\nline two\nline three");
    const change = computeReseedChange(old, next);
    expect(change.from).toBe(old.length);
    expect(change.to).toBe(old.length);
    expect(applyChange(old, change)).toBe(next.toString());
  });

  it("a prepend leaves the common suffix untouched (to at 0-side)", () => {
    const old = splitToCmText("body\nmore");
    const next = splitToCmText("new heading\n\nbody\nmore");
    const change = computeReseedChange(old, next);
    expect(change.from).toBe(0);
    // A prepend deletes nothing — the entire old doc is the common suffix, so
    // `to` trims back to 0. Asserting `to` (not just `from` + round-trip) is what
    // pins the suffix scan: round-trip reassembly alone cannot detect a
    // non-minimal `to` because the extra span is absorbed into `insert`.
    expect(change.to).toBe(0);
    expect(applyChange(old, change)).toBe(next.toString());
  });

  it("fully divergent content degrades to a whole-doc replace", () => {
    const old = splitToCmText("aaaa");
    const next = splitToCmText("bbbbbb");
    const change = computeReseedChange(old, next);
    expect(change.from).toBe(0);
    expect(change.to).toBe(old.length);
    expect(applyChange(old, change)).toBe(next.toString());
  });

  it("identical content yields an empty no-op change", () => {
    const old = splitToCmText("same\ncontent");
    const change = computeReseedChange(old, splitToCmText("same\ncontent"));
    expect(change.from).toBe(change.to);
    expect(change.insert.length).toBe(0);
    expect(applyChange(old, change)).toBe(old.toString());
  });

  it("overlapping prefix/suffix runs do not double-count (from <= to)", () => {
    // "aaa" -> "aa": prefix and suffix both want the shared 'a's; the span
    // must stay non-negative (from <= to) so the change is valid.
    const old = splitToCmText("aaa");
    const next = splitToCmText("aa");
    const change = computeReseedChange(old, next);
    expect(change.from).toBeLessThanOrEqual(change.to);
    expect(applyChange(old, change)).toBe(next.toString());
  });

  it("a surrogate-pair difference reassembles exactly (may split mid-pair)", () => {
    // U+1F600 (😀, D83D DE00) -> U+1F603 (😃, D83D DE03): differ only in the
    // low surrogate, so prefix stops mid-pair. Result must still be exact.
    const old = splitToCmText("a😀b");
    const next = splitToCmText("a😃b");
    const change = computeReseedChange(old, next);
    expect(change.from).toBeLessThanOrEqual(change.to);
    expect(applyChange(old, change)).toBe(next.toString());
  });

  it("multi-line CRLF-origin content diffs in LF-internal coordinates", () => {
    // splitToCmText strips the \r, so both operands are LF-internal; the change
    // offsets are in doc.length space (the CRLF regression guard at unit level).
    const old = splitToCmText("x\r\ny\r\nz"); // internal "x\ny\nz", length 5
    const next = splitToCmText("x\r\nY\r\nz"); // 'y' -> 'Y'
    const change = computeReseedChange(old, next);
    expect(change.to).toBeLessThanOrEqual(old.length); // never exceeds doc.length
    expect(change.insert.toString()).toBe("Y");
    expect(applyChange(old, change)).toBe("x\ny\nz".replace("y", "Y"));
  });

  // The Text-iterator scan must produce exactly the span the shared string core
  // would, across cases that exercise chunk boundaries (multi-leaf trees),
  // surrogate splits, empty lines, and prefix/suffix overlap. Round-trip alone
  // cannot catch a non-minimal span (it hides inside `insert`), so assert
  // from/to/insert against the reference too.
  it("stays byte-for-byte in lockstep with the shared string core", () => {
    const bigA = Array.from({ length: 4000 }, (_, i) => `line ${i} alpha`).join("\n");
    // Diverge deep inside the doc so both the common prefix and suffix span many
    // leaf chunks (a Text of this size is a multi-node tree, not one leaf).
    const bigB = bigA.replace("line 2000 alpha", "line 2000 BRAVO");
    // `Text.iter()` yields ONE line (or one "\n") per step — not a whole
    // TextLeaf block — so commonRunLength's "chunks" are individual lines. Two
    // classes of multi-line edit exercise it differently:
    //
    //  - Whole-line insert/delete (bigInteriorInsert/Delete): the divergence
    //    lands on a line boundary, so both cursors are at pa == pb == 0 there
    //    and only ever refill in lockstep. A coupled-refill implementation
    //    produces the same span, so these do NOT pin the independent pa/pb
    //    refill (they are still useful multi-line coverage).
    //  - Interior mid-line LENGTH change: one line's length differs while all
    //    other lines stay identical, so ONE cursor exhausts its line mid-scan
    //    while the other still has characters left — the exact state the
    //    independent refill exists for. A coupled refill would skip the longer
    //    line's remainder, re-align with the identical run of lines beyond it,
    //    and spuriously match onward (a grossly non-minimal span). These are the
    //    load-bearing regression guard, and the direction matters because
    //    commonRunLength runs the SAME scan both ways: a change at the END of a
    //    line (bigInteriorGrow/Shrink) exercises only the forward prefix scan's
    //    independent refill; a change at the START of a line (revFirstLineHeadGrow)
    //    is needed to exercise the reverse suffix scan's independent refill.
    const rows = Array.from({ length: 300 }, (_, i) => `row ${i} text`);
    const bigBase = rows.join("\n");
    const bigInteriorInsert = [
      ...rows.slice(0, 150),
      "extra 0",
      "extra 1",
      "extra 2",
      "extra 3",
      "extra 4",
      "extra 5",
      ...rows.slice(150),
    ].join("\n");
    const bigInteriorDelete = [...rows.slice(0, 150), ...rows.slice(160)].join("\n");
    // FORWARD-scan guard: line 150's TAIL changes while lines 151..299 stay
    // identical, so the forward prefix scan matches the shared line head, then
    // one cursor exhausts mid-line. Grow keeps the full "row 150 text" head and
    // appends; shrink keeps only its first 3 chars ("row"). Either way one
    // cursor is left mid-line while the other has exhausted its line.
    const bigInteriorGrow = [
      ...rows.slice(0, 150),
      `${rows[150]} EXTENDED TAIL CONTENT`,
      ...rows.slice(151),
    ].join("\n");
    const bigInteriorShrink = [
      ...rows.slice(0, 150),
      rows[150].slice(0, 3),
      ...rows.slice(151),
    ].join("\n");
    // REVERSE-scan guard: the FIRST line differs (so the common prefix is ~0,
    // leaving the suffix scan a large cap to overmatch into) AND interior line
    // 150's HEAD changes while lines 151..299 stay identical. The backward suffix
    // scan matches the shared tail of line 150, then one cursor exhausts mid-line
    // in the dir === -1 pass — the independent-refill state the tail-change cases
    // above never reach in reverse (there the suffix scan diverges at the line's
    // trailing edge). A reverse coupled refill skips the changed head and
    // spuriously matches lines 149..1 back toward the differing first line, over-
    // widening the deletion. (A pure interior head-change with an identical first
    // line does NOT distinguish: the cap `maxPrefix - prefix` would then exactly
    // equal the correct suffix, leaving no room to overmatch — verified.)
    const revFirstLineBase = [
      "ZZZ first",
      ...rows.slice(1, 150),
      rows[150],
      ...rows.slice(151),
    ].join("\n");
    const revFirstLineHeadGrow = [
      "QQQ first",
      ...rows.slice(1, 150),
      `HEAD EXTENSION ${rows[150]}`,
      ...rows.slice(151),
    ].join("\n");
    const cases: Array<[string, string]> = [
      ["", ""],
      ["", "abc"],
      ["abc", ""],
      ["same", "same"],
      ["aaa", "aa"],
      ["aa", "aaa"],
      ["a😀b", "a😃b"],
      ["😀😀😀", "😀😃😀"],
      ["line one\n\nline three", "line one\nline two\nline three"], // empty middle line
      ["\n\n\n", "\n\nx\n"],
      ["head\nbody\ntail", "head\nBODY\ntail"],
      [bigA, bigB],
      [bigA, `${bigA}\nappended tail`],
      [`prepended head\n${bigA}`, bigA],
      [bigBase, bigInteriorInsert],
      [bigBase, bigInteriorDelete],
      [bigBase, bigInteriorGrow], // tail change, new longer → forward refill, old cursor exhausts first
      [bigInteriorGrow, bigBase], // tail change, old longer → forward refill, new cursor exhausts first
      [bigBase, bigInteriorShrink], // tail change, shorter, still shares the in-line head
      [revFirstLineBase, revFirstLineHeadGrow], // head change, new longer → reverse refill, old cursor exhausts first
      [revFirstLineHeadGrow, revFirstLineBase], // head change, old longer → reverse refill, new cursor exhausts first
    ];
    for (const [a, b] of cases) {
      const oldDoc = splitToCmText(a);
      const newDoc = splitToCmText(b);
      const change = computeReseedChange(oldDoc, newDoc);
      const ref = deriveViaStringCore(oldDoc, newDoc);
      expect({ from: change.from, to: change.to, insert: change.insert.toString() }).toEqual(ref);
      expect(applyChange(oldDoc, change)).toBe(newDoc.toString());
    }
  });

  it("never flattens either whole document to a string", () => {
    // The reseed side is deliberately uncapped (host→webview content has no
    // MAX_CONTENT_LENGTH), so a large external reseed must not transiently
    // allocate two full-document strings. Guard the contract by failing if
    // computeReseedChange calls `.toString()` on either operand.
    const bigA = Array.from({ length: 4000 }, (_, i) => `line ${i} content`).join("\n");
    const bigB = bigA.replace("line 2000 content", "line 2000 CHANGED");
    const old = splitToCmText(bigA);
    const next = splitToCmText(bigB);
    const expected = next.toString();
    let flattened = 0;
    old.toString = () => {
      flattened++;
      return bigA;
    };
    next.toString = () => {
      flattened++;
      return bigB;
    };
    const change = computeReseedChange(old, next);
    expect(flattened).toBe(0);
    // Correctness still holds via the un-flattened path.
    const oldStr = bigA;
    expect(oldStr.slice(0, change.from) + change.insert.toString() + oldStr.slice(change.to)).toBe(
      expected
    );
  });
});
