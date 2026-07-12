import { describe, expect, it } from "vitest";
import { lintMarkdown } from "../../../src/webview/cm/lint/engine.js";

const headingDiags = (doc: string) =>
  lintMarkdown(doc).filter((d) => d.code === "heading-increment");

describe("lint rule: heading-increment", () => {
  it("flags an h1 -> h3 skip on the h3 heading", () => {
    const doc = "# Title\n\n### Sub\n";
    const diags = headingDiags(doc);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe("warning");
    // "# Title\n\n" is 9 chars, so "### Sub" starts at offset 9.
    expect(d.from).toBe(9);
    expect(doc.slice(d.from, d.to)).toBe("### Sub");
  });

  it("does not flag a proper h1 -> h2 -> h3 sequence", () => {
    expect(headingDiags("# A\n\n## B\n\n### C\n")).toHaveLength(0);
  });

  it("does not flag stepping back down then up by one (h2 -> h1 -> h2)", () => {
    expect(headingDiags("## A\n\n# B\n\n## C\n")).toHaveLength(0);
  });

  it("flags each skip independently (h1 -> h4 and later h2 -> h5)", () => {
    expect(headingDiags("# A\n\n#### B\n\n## C\n\n##### D\n")).toHaveLength(2);
  });
});
