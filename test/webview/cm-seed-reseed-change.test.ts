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
    const bigA = `${Array.from({ length: 4000 }, (_, i) => `line ${i} alpha`).join("\n")}`;
    // Diverge deep inside the doc so both the common prefix and suffix span many
    // leaf chunks (a Text of this size is a multi-node tree, not one leaf).
    const bigB = bigA.replace("line 2000 alpha", "line 2000 BRAVO");
    // bigA/bigB keep the line count fixed (an in-place word swap), so their
    // TextLeaf chunk boundaries stay 1:1 aligned across the whole scan — that
    // never exercises commonRunLength's independent pa/pb refill (each side
    // only ever refills in lockstep with the other). The cases below add a
    // genuinely multi-leaf tree (300 lines, well past the ~32-line leaf branch
    // factor) where the interior line COUNT changes, so every leaf boundary
    // past the edit point is offset between old and new — exactly the
    // misalignment the independent refill exists to handle.
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
