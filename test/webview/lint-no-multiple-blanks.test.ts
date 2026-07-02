import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../src/webview/cm/lint/engine.js";

const blankDiags = (doc: string) =>
  lintMarkdown(doc).filter((d) => d.code === "no-multiple-blanks");

describe("lint rule: no-multiple-blanks", () => {
  it("does not flag a single blank line between paragraphs", () => {
    expect(blankDiags("a\n\nb\n")).toHaveLength(0);
  });

  it("flags the second of two consecutive blank lines (whole-line, zero-length, info)", () => {
    const doc = "a\n\n\nb\n"; // a@0, ""@2, ""@3, b@4
    const diags = blankDiags(doc);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("info");
    expect(d.wholeLine).toBe(true);
    expect(d.from).toBe(3);
    expect(d.to).toBe(3); // zero-length: the line decoration carries the visibility
  });

  it("flags each excess blank line in a longer run (3 blanks -> 2 findings)", () => {
    expect(blankDiags("a\n\n\n\nb\n")).toHaveLength(2);
  });

  it("does not flag a single trailing newline", () => {
    expect(blankDiags("a\n")).toHaveLength(0);
  });

  it("does not count a trailing newline as an extra blank line", () => {
    // "a\n\n" is one trailing blank line, not multiple.
    expect(blankDiags("a\n\n")).toHaveLength(0);
  });

  it("flags leading consecutive blank lines", () => {
    expect(blankDiags("\n\na\n")).toHaveLength(1);
  });

  it("treats a whitespace-only line as blank", () => {
    expect(blankDiags("a\n   \n\nb\n")).toHaveLength(1);
  });

  it("spans a flagged whitespace-only line's content (so hover hits past column 0)", () => {
    const doc = "a\n\n   \nb\n"; // ""@2 (allowed), "   "@3 (excess, flagged)
    const diags = blankDiags(doc);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.wholeLine).toBe(true);
    expect(d.from).toBe(3);
    expect(d.to).toBe(6); // covers the three spaces, not just the line start
  });

  it("does NOT flag blank lines inside a fenced code block", () => {
    const doc = "```js\nlet x = 1;\n\n\nlet y = 2;\n```\n";
    expect(blankDiags(doc)).toHaveLength(0);
  });

  it("does NOT flag blank lines inside an indented code block", () => {
    // 4-space-indented lines form a CodeBlock spanning the interior double blank
    // (verified against the live Lezer parser: CodeBlock [10,19] for this doc).
    const doc = "text\n\n    a\n\n\n    b\n";
    expect(blankDiags(doc)).toHaveLength(0);
  });

  it("flags pre-fence blanks but not the in-fence blanks", () => {
    const doc = "a\n\n\n```\n\n\ncode\n```\n";
    expect(blankDiags(doc)).toHaveLength(1);
  });
});
