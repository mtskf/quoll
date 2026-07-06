import { describe, expect, it } from "vitest";
import { diffRange } from "../../src/markdown/lezer-url-walker.js";

describe("diffRange", () => {
  it("returns an empty range for identical text", () => {
    expect(diffRange("hello", "hello")).toEqual({ fromA: 5, toA: 5, fromB: 5, toB: 5 });
  });

  it("brackets a single-character insertion by common prefix/suffix", () => {
    expect(diffRange("abc", "abXc")).toEqual({ fromA: 2, toA: 2, fromB: 2, toB: 3 });
  });

  it("brackets a deletion", () => {
    expect(diffRange("abXc", "abc")).toEqual({ fromA: 2, toA: 3, fromB: 2, toB: 2 });
  });

  it("does not let the suffix overlap the prefix (full replacement)", () => {
    expect(diffRange("aaaa", "bbbb")).toEqual({ fromA: 0, toA: 4, fromB: 0, toB: 4 });
  });
});
