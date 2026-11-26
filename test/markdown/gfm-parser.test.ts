import { type SyntaxNode, type Tree, TreeFragment } from "@lezer/common";
import { describe, expect, it } from "vitest";
import { gfmParser } from "../../src/markdown/gfm-parser.js";

/** Every ListItem span, in document order. */
function listItems(tree: Tree): string[] {
  const out: string[] = [];
  tree.iterate({
    enter: (n) => {
      if (n.name === "ListItem") {
        out.push(`${n.from}-${n.to}`);
      }
    },
  });
  return out;
}

/** The ListItem holding offset `pos`, as `from-to`, or null outside any item. */
function itemAt(doc: string, pos: number): string | null {
  let n: SyntaxNode | null = gfmParser.parse(doc).resolveInner(pos, 1);
  while (n !== null && n.name !== "ListItem") {
    n = n.parent;
  }
  return n === null ? null : `${n.from}-${n.to}`;
}

describe("gfmParser", () => {
  it("parses a GFM table (GFM extension is configured)", () => {
    const tree = gfmParser.parse("| a | b |\n| - | - |\n| 1 | 2 |\n");
    let sawTable = false;
    tree.iterate({
      enter: (n) => {
        if (n.name === "Table") {
          sawTable = true;
        }
      },
    });
    expect(sawTable).toBe(true);
  });

  it("emits a HardBreak node for a two-space line break", () => {
    const tree = gfmParser.parse("a  \nb\n");
    let sawHardBreak = false;
    tree.iterate({
      enter: (n) => {
        if (n.name === "HardBreak") {
          sawHardBreak = true;
        }
      },
    });
    expect(sawHardBreak).toBe(true);
  });
});

// Bare-marker items under @lezer/markdown 1.8.1 + patches/@lezer__markdown@1.8.1.patch.
// CommonMark: a bare item may start with at most one blank line, so a blank right
// after the marker ends it; a blank between two body blocks does not. Stock 1.8.1
// ends the item at the later blank too, and its tree depends on edit history.
describe("gfmParser — bare-marker list items", () => {
  it.each([
    ["-\n\n  body", "0-1"],
    ["9.\n\n   body", "0-2"],
    ["9. \n\n   body", "0-3"],
  ])("ends the item at a blank line right after the marker (%j)", (doc, item) => {
    expect(listItems(gfmParser.parse(doc))).toEqual([item]);
    expect(itemAt(doc, doc.indexOf("body"))).toBeNull();
  });

  it.each([
    ["-\n  first\n\n  second"],
    ["9. \n   first\n\n   second"],
  ])("keeps a later blank line inside the item (%j)", (doc) => {
    expect(itemAt(doc, doc.indexOf("first"))).toBe(`0-${doc.length}`);
    expect(itemAt(doc, doc.indexOf("second"))).toBe(`0-${doc.length}`);
  });

  it("gives an incrementally reparsed item the same tree as a fresh parse", () => {
    const tail = Array.from({ length: 40 }, (_, i) => `para ${i}`).join("\n\n");
    const body = "\n  first line of the item body\n\n  second paragraph of the item\n\n";
    const before = `-${body}${tail}`;
    const after = `- ${body}${tail}`;
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(gfmParser.parse(before)), [
      { fromA: 1, toA: 1, fromB: 1, toB: 2 },
    ]);
    const incremental = gfmParser.parse(after, fragments);
    expect(listItems(incremental)).toEqual(listItems(gfmParser.parse(after)));
    expect(listItems(incremental)).toEqual([`0-${after.indexOf("item\n\npara") + 4}`]);
  });
});

// The GFM table parser's endLeaf tests the line after a pipe-bearing paragraph line
// against delimiterLine. Upstream 1.8.1's spelling backtracks quadratically on a
// long indent (about 1 s here); the patched one is linear. Tabs, not spaces: a long
// space run also hits the inline HardBreak scan, a separate quadratic path that
// 1.6.4 already had and this patch does not touch.
describe("gfmParser — long indented line after a table-like line", () => {
  it("parses a 40,000-tab indent in linear time", () => {
    const doc = `intro\nx | y\n${"\t".repeat(40_000)}plain prose`;
    const start = performance.now();
    const tree = gfmParser.parse(doc);
    expect(performance.now() - start).toBeLessThan(200);
    expect(tree.toString()).toBe("Document(Paragraph)");
  });
});
