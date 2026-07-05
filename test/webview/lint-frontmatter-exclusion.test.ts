import { describe, expect, it } from "vitest";

import { lintMarkdown } from "../../src/webview/cm/lint/engine.js";

// The lint engine excludes a file-leading YAML frontmatter block from linting,
// matching markdownlint's default (front matter is not Markdown). Without this,
// YAML lines parse as Markdown and feed false positives into the Problems mirror:
// a `# comment` becomes an ATXHeading, trailing spaces / double blanks inside the
// block get flagged, and a frontmatter heading collides with a body heading.
describe("lint engine: leading frontmatter exclusion", () => {
  it("raises zero diagnostics inside the frontmatter fence", () => {
    // Frontmatter body carries a `#`-line, trailing spaces, and a double blank —
    // every one of which a rule would flag if the block were linted as Markdown.
    const fm = "---\n# Section  \ntitle: x\n\n\nkey: y\n---\n";
    const doc = `${fm}# Body\n`;
    const diags = lintMarkdown(doc);
    const fenceEnd = fm.length;
    const insideFence = diags.filter((d) => d.from < fenceEnd);
    expect(insideFence).toEqual([]);
  });

  it("leaves body findings intact with correct absolute positions", () => {
    const fm = "---\ntitle: x\n---\n";
    const doc = `${fm}# A\n\n### C\n`; // h1 -> h3 skip: heading-increment on `### C`
    const diags = lintMarkdown(doc);
    const incr = diags.filter((d) => d.code === "heading-increment");
    expect(incr).toHaveLength(1);
    expect(doc.slice(incr[0]!.from, incr[0]!.to)).toBe("### C");
  });

  it("does not let a frontmatter heading make a body heading a duplicate", () => {
    // `# Section` appears in BOTH the frontmatter and the body. Excluding the
    // frontmatter means the body heading is the sole occurrence — not a duplicate.
    const doc = "---\n# Section\n---\n\n# Section\n";
    const dups = lintMarkdown(doc).filter((d) => d.code === "duplicate-heading-text");
    expect(dups).toEqual([]);
  });

  it("still lints a `---`-leading document that has no closing fence", () => {
    // No closer → CommonMark treats the leading `---` as a thematic break + prose,
    // not frontmatter, so normal linting applies.
    const doc = "---\n## A\n\n## A\n";
    const dups = lintMarkdown(doc).filter((d) => d.code === "duplicate-heading-text");
    expect(dups).toHaveLength(1);
    expect(doc.slice(dups[0]!.from, dups[0]!.to)).toBe("## A"); // second occurrence
  });

  it("lints normally when there is no frontmatter", () => {
    const doc = "# A\n\n### C\n";
    const incr = lintMarkdown(doc).filter((d) => d.code === "heading-increment");
    expect(incr).toHaveLength(1);
    expect(doc.slice(incr[0]!.from, incr[0]!.to)).toBe("### C");
  });

  it("excludes a CRLF frontmatter block and keeps body positions correct", () => {
    const fm = "---\r\n# Section  \r\n---\r\n";
    const doc = `${fm}# Body\r\n\r\n### C\r\n`;
    const diags = lintMarkdown(doc);
    expect(diags.filter((d) => d.from < fm.length)).toEqual([]);
    const incr = diags.filter((d) => d.code === "heading-increment");
    expect(incr).toHaveLength(1);
    // The ATX node's `to` extends over the trailing CR (parser behaviour, not
    // frontmatter-specific); assert the flagged run starts at the body `### C`.
    expect(doc.slice(incr[0]!.from).startsWith("### C")).toBe(true);
  });
});
