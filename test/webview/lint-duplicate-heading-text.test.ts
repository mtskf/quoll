import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../src/webview/cm/lint/engine.js";

const dupDiags = (doc: string) =>
  lintMarkdown(doc).filter((d) => d.code === "duplicate-heading-text");

describe("lint rule: duplicate-heading-text", () => {
  it("flags the second occurrence of a duplicate heading", () => {
    const doc = "# Intro\n\n## Setup\n\n## Setup\n";
    const diags = dupDiags(doc);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("warning");
    expect(doc.slice(d.from, d.to)).toBe("## Setup"); // the SECOND occurrence
  });

  it("does not flag headings with distinct text", () => {
    expect(dupDiags("# A\n\n## B\n\n### C\n")).toHaveLength(0);
  });

  it("treats different levels with the same text as duplicates", () => {
    expect(dupDiags("# Notes\n\n## Notes\n")).toHaveLength(1);
  });

  it("normalizes closing-hash and whitespace variants as equal", () => {
    expect(dupDiags("## Setup\n\n##   Setup   ##\n")).toHaveLength(1);
  });

  it("does not strip a content hash (## C# differs from ## C)", () => {
    expect(dupDiags("## C#\n\n## C\n")).toHaveLength(0);
  });

  it("ignores empty headings (no text to compare)", () => {
    expect(dupDiags("#\n\n#\n")).toHaveLength(0);
  });

  it("ignores empty space-separated ATX headings (`## ##` is empty, not duplicate `##`)", () => {
    expect(dupDiags("## ##\n\n## ##\n")).toHaveLength(0);
  });

  it("flags every later occurrence (3x heading -> 2 findings)", () => {
    expect(dupDiags("# Dup\n\n# Dup\n\n# Dup\n")).toHaveLength(2);
  });
});
