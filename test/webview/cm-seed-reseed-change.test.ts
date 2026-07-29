import type { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { computeReseedChange, splitToCmText } from "../../src/webview/cm/seed.js";

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
});
