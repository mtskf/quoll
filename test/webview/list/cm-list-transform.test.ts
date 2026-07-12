// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { formatMarker, parseListMark } from "../../../src/webview/cm/list/list-transform.js";

describe("parseListMark", () => {
  it("classifies bullet glyphs", () => {
    expect(parseListMark("-")).toEqual({ kind: "bullet", glyph: "-" });
    expect(parseListMark("*")).toEqual({ kind: "bullet", glyph: "*" });
    expect(parseListMark("+")).toEqual({ kind: "bullet", glyph: "+" });
  });
  it("classifies ordered markers, multi-digit, both delimiters", () => {
    expect(parseListMark("1.")).toEqual({ kind: "ordered", number: 1, delim: "." });
    expect(parseListMark("10)")).toEqual({ kind: "ordered", number: 10, delim: ")" });
    expect(parseListMark("999999999.")).toEqual({ kind: "ordered", number: 999999999, delim: "." });
  });
  it("rejects a 10+-digit run (Lezer does not treat it as a ListMark)", () => {
    expect(parseListMark("1234567890.")).toBeNull();
  });
  it("returns null on non-marker text", () => {
    expect(parseListMark("x")).toBeNull();
  });
});

describe("formatMarker", () => {
  it("round-trips (zero-pad width not preserved — plain decimal)", () => {
    expect(formatMarker({ kind: "bullet", glyph: "*" })).toBe("*");
    expect(formatMarker({ kind: "ordered", number: 3, delim: ")" })).toBe("3)");
  });
});
