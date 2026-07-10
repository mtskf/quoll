// test/webview/reading-stats-structure.test.ts
import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { countStructure } from "../../src/webview/cm/reading-stats/structure.js";

function counts(doc: string) {
  const state = EditorState.create({ doc, extensions: [quollMarkdownLanguage()] });
  return countStructure(syntaxTree(state));
}

describe("countStructure", () => {
  it("counts ATX headings across levels and nested blocks", () => {
    expect(counts("# A\n\n## B\n\n> ### C").headings).toBe(3);
  });

  it("does not count `#` inside fenced code as a heading", () => {
    expect(counts("```\n# not a heading\n```\n").headings).toBe(0);
  });

  it("counts inline and reference links", () => {
    const doc = "See [one](https://a.example) and [two][ref].\n\n[ref]: https://b.example";
    expect(counts(doc).links).toBe(2);
  });

  it("reports zero counts for prose with no headings or links", () => {
    expect(counts("just some plain prose here")).toEqual({ headings: 0, links: 0 });
  });

  it("does not count images or autolinks as links (only explicit Link nodes)", () => {
    // Image (![](...)) and Autolink (<https://...>) are distinct Lezer node
    // types; countStructure tallies only `Link` nodes.
    const doc = "![alt](img.png) x <https://auto.example> y [real](https://e.example)";
    expect(counts(doc).links).toBe(1); // only the [real](...) link
  });
});
