import { describe, expect, it } from "vitest";
import { formatDocument, formatDocumentEdits } from "../../../src/markdown/format/index.js";

describe("formatDocument", () => {
  it("applies table, renumber, blank, and trim rules together", () => {
    const src = "# Title  \n\n\n\n1. x\n1. y\n\n| a | bb |\n| - | - |\n| 1 | 2 |\n";
    const out = formatDocument(src);
    expect(out).toContain("# Title  "); // trailing 2 spaces byte-preserved
    expect(out).toContain("1. x\n2. y");
    expect(out).toContain("| a   | bb  |");
    expect(out).not.toContain("\n\n\n");
  });
  it("leaves fenced code contents byte-untouched", () => {
    const src = "```js\nlet   a=1   \n1.  not renumbered\n```\n";
    expect(formatDocument(src)).toBe(src);
  });
  it("leaves raw HTML block contents byte-untouched", () => {
    const src = "<div>\n  <b>keep   spaces</b>   \n</div>\n";
    expect(formatDocument(src)).toBe(src);
  });
  it("leaves frontmatter byte-untouched", () => {
    const src = "---\ntitle:   x   \nlist:\n  - a\n---\n\nbody\n";
    expect(formatDocument(src)).toContain("title:   x   ");
  });
  it("does not trim inside a table (interior whitespace owned by table rule)", () => {
    // ragged table left byte-untouched incl. its own spacing
    const src = "| a | b |\n| - | - |\n| only |\n";
    expect(formatDocument(src)).toBe(src);
  });
  it("returns empty input unchanged / empty edit list", () => {
    expect(formatDocument("")).toBe("");
    expect(formatDocumentEdits("")).toEqual([]);
  });
  it("unifies safe bullet markers to - and leaves risky lists alone", () => {
    expect(formatDocument("* a\n* b\n")).toBe("- a\n- b\n"); // safe -> unified
    expect(formatDocument("+ a\n+ b\n")).toBe("- a\n- b\n"); // safe -> unified
    expect(formatDocument("* a\n+ b\n")).toBe("* a\n+ b\n"); // adjacent -> untouched
    expect(formatDocument("* a\n\n- b\n")).toBe("* a\n\n- b\n"); // blank-sep diff -> untouched
    expect(formatDocument("> * a\n> - b\n")).toBe("> * a\n> - b\n"); // blockquote-adjacent -> untouched
    expect(formatDocument("> * a\n> * b\n")).toBe("> - a\n> - b\n"); // blockquote-standalone -> unified
    expect(formatDocument("* --\n")).toBe("* --\n"); // thematic-break collision -> untouched
    expect(formatDocument("> > * a\n> > - b\n")).toBe("> > * a\n> > - b\n"); // deep-blockquote adjacent -> untouched
    // per-list granularity: colliding list skipped, unrelated safe list unified
    expect(formatDocument("* good\n\n# separator\n\n* a\n* --\n")).toBe(
      "- good\n\n# separator\n\n* a\n* --\n"
    );
  });
  it("unifies list markers even under GFM task-list items", () => {
    expect(formatDocument("* [ ] a\n* [x] b\n")).toBe("- [ ] a\n- [x] b\n");
  });
  it("unifies a bullet list directly under a paragraph (no blank line)", () => {
    expect(formatDocument("para\n* a\n* b\n")).toBe("para\n- a\n- b\n");
  });
  it("unifies a bullet list directly after an ordered list (no blank line)", () => {
    expect(formatDocument("1. a\n* b\n")).toBe("1. a\n- b\n");
  });
  it("unifies `* -` (its `- -` is not a thematic break)", () => {
    expect(formatDocument("* -\n")).toBe("- -\n");
  });
  it("leaves a would-split list untouched (rewrite would insert a thematic break)", () => {
    // `* a\n* --\n* b` -> `- a\n- --\n- b` splits one list into list+HR+list.
    expect(formatDocument("* a\n* --\n* b\n")).toBe("* a\n* --\n* b\n");
  });
  it("no-ops safely on nested collinear markers that would collapse to a rule", () => {
    // `+ + +` is three nested (each adjacencySafe) lists; unifying all collapses
    // to `- - -` (a HorizontalRule), so the combined backstop drops the rewrite.
    // Accepted conservative behaviour: the whole rule no-ops (never corrupts).
    expect(formatDocument("+ + +\n")).toBe("+ + +\n");
    expect(formatDocument("* x\n* y\n\n# s\n\n+ + +\n")).toBe("* x\n* y\n\n# s\n\n+ + +\n");
  });
});
