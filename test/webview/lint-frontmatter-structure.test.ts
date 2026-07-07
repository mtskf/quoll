import { describe, expect, it } from "vitest";
import { frontmatterContentLines } from "../../src/webview/cm/lint/frontmatter-range.js";

describe("frontmatterContentLines", () => {
  it("returns the lines strictly between the fences, with absolute offsets", () => {
    const block = "---\ntitle: a\ntags: b\n---\n";
    const lines = frontmatterContentLines(block);
    expect(lines.map((l) => l.content)).toEqual(["title: a", "tags: b"]);
    // "---\n" is 4 chars, so "title: a" starts at offset 4.
    expect(lines[0]!.from).toBe(4);
    expect(block.slice(lines[0]!.from, lines[0]!.from + lines[0]!.content.length)).toBe("title: a");
  });

  it("returns [] for an empty frontmatter block (opener immediately closed)", () => {
    expect(frontmatterContentLines("---\n---\n")).toEqual([]);
  });

  it("excludes the closing fence line itself", () => {
    const lines = frontmatterContentLines("---\nk: 1\n---\n");
    expect(lines.map((l) => l.content)).toEqual(["k: 1"]);
  });

  it("handles a CRLF block (terminators stripped, offsets absolute)", () => {
    const block = "---\r\nk: 1\r\n---\r\n";
    const lines = frontmatterContentLines(block);
    expect(lines.map((l) => l.content)).toEqual(["k: 1"]);
    // "---\r\n" is 5 chars, so "k: 1" starts at offset 5; the span excludes the CRLF.
    expect(lines[0]!.from).toBe(5);
    expect(block.slice(lines[0]!.from, lines[0]!.from + lines[0]!.content.length)).toBe("k: 1");
  });
});
