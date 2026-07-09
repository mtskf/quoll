import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../src/webview/cm/lint/engine.js";

const blankDiags = (doc: string) =>
  lintMarkdown(doc).filter((d) => d.code === "no-multiple-blanks");

// Apply every no-multiple-blanks fix to `doc` as a single delete pass, mirroring
// what applyLintFixAtSelection dispatches. Fixes are absolute ranges over the
// original doc, so applying them high-offset-first keeps earlier offsets valid.
const applyBlankFixes = (doc: string): string => {
  const fixes = blankDiags(doc)
    .map((d) => d.fix)
    .filter((f): f is NonNullable<typeof f> => f !== undefined)
    .sort((a, b) => b.from - a.from);
  let out = doc;
  for (const f of fixes) {
    out = out.slice(0, f.from) + f.insert + out.slice(f.to);
  }
  return out;
};

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

  describe("opt-in autofix", () => {
    it("carries a fix that deletes the excess blank line INCLUDING its terminator", () => {
      const doc = "a\n\n\nb\n"; // ""@2 (allowed), ""@3 (excess, flagged)
      const d = blankDiags(doc)[0]!;
      // The fix range is NOT the diagnostic range: the diagnostic spans zero-length
      // content @3, but the fix must remove the line PLUS its "\n" terminator.
      expect(d.fix).toEqual({ from: 3, to: 4, insert: "" });
      expect(applyBlankFixes(doc)).toBe("a\n\nb\n"); // collapsed to one blank
    });

    it("collapses a 3-blank run to exactly one blank line", () => {
      expect(applyBlankFixes("a\n\n\n\nb\n")).toBe("a\n\nb\n");
    });

    it("deletes the CRLF terminator when the run uses CRLF", () => {
      const doc = "a\r\n\r\n\r\nb\r\n"; // ""@3 (allowed), ""@5 (excess, flagged)
      const d = blankDiags(doc)[0]!;
      expect(d.fix).toEqual({ from: 5, to: 7, insert: "" }); // removes the "\r\n"
      expect(applyBlankFixes(doc)).toBe("a\r\n\r\nb\r\n");
    });

    it("deletes the lone-CR terminator when the run uses lone-CR (no LF)", () => {
      const doc = "a\r\r\rb\r"; // ""@2 (allowed), ""@3 (excess, flagged)
      const d = blankDiags(doc)[0]!;
      expect(d.fix).toEqual({ from: 3, to: 4, insert: "" }); // removes the lone "\r"
      expect(applyBlankFixes(doc)).toBe("a\r\rb\r");
    });

    it("collapses leading blank lines at BOF", () => {
      expect(applyBlankFixes("\n\na\n")).toBe("\na\n");
    });

    it("deletes content only for a whitespace-only final line with no terminator (EOF)", () => {
      const doc = "a\n\n   "; // ""@2 (allowed), "   "@3 (excess, no own terminator)
      const d = blankDiags(doc)[0]!;
      // No own terminator to delete — remove just the whitespace content; the
      // preceding "\n" stays as the surviving blank line's terminator.
      expect(d.fix).toEqual({ from: 3, to: 6, insert: "" });
      expect(applyBlankFixes(doc)).toBe("a\n\n"); // exactly one blank line
    });

    it("leaves a single-blank document byte-identical (no fix emitted)", () => {
      const doc = "a\n\nb\n";
      expect(blankDiags(doc)).toHaveLength(0);
      expect(applyBlankFixes(doc)).toBe(doc);
    });
  });
});
