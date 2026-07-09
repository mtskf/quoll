import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { collectHeadings } from "../../src/webview/cm/headings.js";
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
