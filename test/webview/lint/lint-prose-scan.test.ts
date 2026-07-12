import { markdownLanguage } from "@codemirror/lang-markdown";
import { describe, expect, it } from "vitest";
import { collectProseParagraphs, countWords } from "../../../src/webview/cm/lint/prose-scan.js";

const PARSER = markdownLanguage.parser;
const paras = (doc: string) => collectProseParagraphs(PARSER.parse(doc), doc);

describe("prose-scan: collectProseParagraphs", () => {
  it("returns each Paragraph's text with its absolute start offset", () => {
    const doc = "First para.\n\nSecond para.\n";
    const got = paras(doc);
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ from: 0, text: "First para." });
    expect(got[1]!.from).toBe(doc.indexOf("Second"));
    expect(got[1]!.text).toBe("Second para.");
  });

  it("includes paragraphs nested in a blockquote and a list item", () => {
    const doc = "> quoted para\n\n- item para\n";
    const texts = paras(doc).map((p) => p.text);
    expect(texts).toContain("quoted para");
    expect(texts).toContain("item para");
  });

  it("excludes non-Paragraph blocks (heading, fenced code, table)", () => {
    const doc = "# Heading\n\n```\ncode line\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";
    // No Paragraph nodes here at all — heading/code/table are their own node kinds.
    expect(paras(doc)).toHaveLength(0);
  });

  it("masks an InlineCode span to spaces, preserving surrounding offsets", () => {
    const doc = "run `is_ready` now";
    const got = paras(doc);
    expect(got).toHaveLength(1);
    const { from, text } = got[0]!;
    expect(from).toBe(0);
    // `is_ready` (10 code units incl. backticks) becomes 10 spaces; "run " and
    // " now" keep their positions, so length is unchanged.
    expect(text).toHaveLength(doc.length);
    expect(text.startsWith("run ")).toBe(true);
    expect(text.endsWith(" now")).toBe(true);
    expect(text).not.toContain("is_ready");
    // The word "run" still sits at offset 0..3 in the masked text.
    expect(text.slice(0, 3)).toBe("run");
  });

  it("masks a link URL but keeps the link text", () => {
    const doc = "see [here](http://very-fast.example) today";
    const text = paras(doc)[0]!.text;
    expect(text).toHaveLength(doc.length);
    expect(text).not.toContain("very-fast");
    expect(text).toContain("here"); // link text is prose, retained
    expect(text).toContain("today");
  });

  it("handles an empty paragraph slice and adjacent masked spans without throwing", () => {
    const doc = "`a``b` end";
    const text = paras(doc)[0]!.text;
    expect(text).toHaveLength(doc.length);
    expect(text.endsWith("end")).toBe(true);
  });
});

describe("prose-scan: countWords", () => {
  it("counts letter/digit-bearing tokens, ignoring stray punctuation", () => {
    expect(countWords("one two three")).toBe(3);
    expect(countWords("well-known isn't split")).toBe(3); // hyphen + apostrophe join
    expect(countWords("<    >  [x](  )")).toBe(1); // masked remnants + the single letter x
    expect(countWords("   ")).toBe(0);
  });
});
