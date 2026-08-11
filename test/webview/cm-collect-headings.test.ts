import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { collectHeadings, headingText, slugifyHeadingText } from "../../src/webview/cm/headings.js";
import { fullTree } from "./helpers/full-tree.js";

function treeOf(doc: string) {
  return fullTree(EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] }));
}

describe("collectHeadings", () => {
  it("collects ATX headings in document order with level/from/to", () => {
    const hs = collectHeadings(treeOf("# a\n\n### c\n\ntext\n"));
    expect(hs.map((h) => h.level)).toEqual([1, 3]);
    expect(hs[0].from).toBe(0);
    expect(hs.every((h) => h.to > h.from)).toBe(true);
  });
  it("ignores non-heading nodes (fenced code, plain text)", () => {
    expect(
      collectHeadings(treeOf("```\n# not a heading\n```\n\n## real\n")).map((h) => h.level)
    ).toEqual([2]);
  });
});

describe("headingText", () => {
  it("strips the ATX opener and an optional closing run", () => {
    expect(headingText("## Getting started")).toBe("Getting started");
    expect(headingText("###   Spaced   ")).toBe("Spaced");
    expect(headingText("## Closed ##")).toBe("Closed");
    expect(headingText("#")).toBe("");
  });

  it("leaves `# #` as a stray hash — which slugs to nothing downstream", () => {
    // Pins the KNOWN divergence from lint/rules/duplicate-heading-text.ts's
    // copy, which strips the closing run FIRST and yields "". Both reach the
    // same place for our purposes (second assertion), so the outline's
    // long-standing behaviour is moved here unchanged rather than "fixed".
    expect(headingText("# #")).toBe("#");
    expect(slugifyHeadingText(headingText("# #"))).toBe("");
  });
});

describe("slugifyHeadingText", () => {
  it("lowercases, drops punctuation and hyphenates whitespace (GitHub-style)", () => {
    expect(slugifyHeadingText("Getting Started")).toBe("getting-started");
    expect(slugifyHeadingText("What's new, really?")).toBe("whats-new-really");
    expect(slugifyHeadingText("  Trim   me  ")).toBe("trim-me");
    expect(slugifyHeadingText("snake_case and dash-case")).toBe("snake_case-and-dash-case");
  });

  it("keeps letters, numbers and marks from non-Latin scripts", () => {
    expect(slugifyHeadingText("設計メモ")).toBe("設計メモ");
    expect(slugifyHeadingText("Café Ünicode")).toBe("café-ünicode");
  });

  it("normalises to NFC so a decomposed heading matches a composed fragment", () => {
    // A macOS-pasted heading can arrive NFD ("e" + U+0301) while the fragment
    // is NFC. Same function on both sides only helps if it canonicalises first.
    expect(slugifyHeadingText("Café")).toBe(slugifyHeadingText("Café"));
    expect(slugifyHeadingText("Café")).toBe("café");
  });

  it("drops emoji and symbol runs rather than transliterating them", () => {
    expect(slugifyHeadingText("🚧 Work in progress")).toBe("work-in-progress");
  });

  it("slugs emphasis and inline code the way GitHub does", () => {
    expect(slugifyHeadingText("Some **bold** heading")).toBe("some-bold-heading");
    expect(slugifyHeadingText("The `foo` API")).toBe("the-foo-api");
  });

  it("pins the KNOWN divergence: a link inside a heading leaks its destination", () => {
    // GitHub slugs the RENDERED text ("a-link"); we slug the raw source. See
    // design decision 3 — an approximation, deliberately not a compatibility
    // claim. The failure mode is benign: no pointer, click stays a caret move.
    expect(slugifyHeadingText("A [link](b)")).toBe("a-linkb");
  });

  it("is idempotent on an already-slugged string", () => {
    const once = slugifyHeadingText("Some **bold** heading!");
    expect(slugifyHeadingText(once)).toBe(once);
  });

  it("returns an empty string for a text with nothing sluggable", () => {
    expect(slugifyHeadingText("!!!")).toBe("");
    expect(slugifyHeadingText("")).toBe("");
  });
});
