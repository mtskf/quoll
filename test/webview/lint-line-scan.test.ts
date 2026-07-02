import { describe, expect, it } from "vitest";
import { scanLines } from "../../src/webview/cm/lint/line-scan.js";

describe("scanLines", () => {
  it("splits LF lines with absolute offsets and a final EOF entry", () => {
    expect(scanLines("a\nbb\n")).toEqual([
      { content: "a", from: 0, terminated: true },
      { content: "bb", from: 2, terminated: true },
      { content: "", from: 5, terminated: false },
    ]);
  });

  it("strips the terminator from CRLF lines (no trailing CR in content)", () => {
    const lines = scanLines("a\r\nb");
    expect(lines[0]).toEqual({ content: "a", from: 0, terminated: true });
    expect(lines[1]).toEqual({ content: "b", from: 3, terminated: false });
  });

  it("treats a lone CR as a terminator", () => {
    const lines = scanLines("a\rb");
    expect(lines.map((l) => l.content)).toEqual(["a", "b"]);
  });

  it("returns a single empty entry for empty input", () => {
    expect(scanLines("")).toEqual([{ content: "", from: 0, terminated: false }]);
  });
});
