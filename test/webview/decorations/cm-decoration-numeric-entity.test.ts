import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { fullTree } from "../helpers/full-tree.js";

function context(doc: string, selection = EditorSelection.single(0)) {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  return {
    state,
    selection: state.selection,
    tree: fullTree(state),
    visibleRanges: [{ from: 0, to: doc.length }],
  };
}

describe("numeric entity parser shapes", () => {
  it("identifies non-prose entity ancestors", () => {
    const doc =
      '![&#97;](url "&#98;") [&#99;](url "&#100;") [x][&#101;]\n\n[&#101;]: /url\n\n<https://x/&#102;> <i title="&#103;"> `&#104;`\n\n```&#105;\nx\n```';
    const found: string[] = [];
    context(doc).tree.iterate({
      enter(node) {
        if (node.name === "Entity") {
          const names: string[] = [];
          for (let p = node.node.parent; p; p = p.parent) {
            names.push(p.name);
          }
          found.push(`${doc.slice(node.from, node.to)}:${names.join("/")}`);
        }
      },
    });
    console.log(found);
    expect(found.some((s) => s.startsWith("&#97;:Image/"))).toBe(true);
    expect(found.some((s) => s.startsWith("&#99;:Link/"))).toBe(true);
  });
});

import { numericEntityReveal } from "../../../src/webview/cm/decorations/numeric-entity-reveal.js";

function entries(c: ReturnType<typeof context>) {
  const iter = numericEntityReveal.build(c).iter();
  const out: Array<{ from: number; to: number; mark: boolean; text?: string }> = [];
  while (iter.value) {
    const spec = iter.value.spec as { class?: string; widget?: { text: string } };
    out.push({ from: iter.from, to: iter.to, mark: !!spec.class, text: spec.widget?.text });
    iter.next();
  }
  return out;
}

describe("numeric entity reveal", () => {
  it("replaces eligible prose references at their exact ranges without changing source", () => {
    const doc = "plain\n\n# &#97;\n\n**&#98;** *&#99;* [&#100;](url)";
    const c = context(doc);
    const result = entries(c);
    expect(result.map((x) => x.text)).toEqual(["a", "b", "c", "d"]);
    expect(result.map((x) => doc.slice(x.from, x.to))).toEqual([
      "&#97;",
      "&#98;",
      "&#99;",
      "&#100;",
    ]);
    expect(c.state.doc.toString()).toBe(doc);
  });
  it("excludes non-prose, malformed, named and layout controls", () => {
    const doc =
      'plain `&#97;` \\&#97; ![&#97;](url "&#98;") [x](url "&#99;") &amp; &#12345678; &#9; &#127; &#x2028; &#x202E; &#x2066; &#0;';
    expect(entries(context(doc)).map((x) => x.text)).toEqual(["�"]);
  });
  it("reveals every caret offset including both boundaries", () => {
    for (const raw of ["&#8288;", "&#97;"]) {
      const doc = `x ${raw} y`;
      for (let i = 2; i <= 2 + raw.length; i++) {
        expect(entries(context(doc, EditorSelection.single(i)))[0]?.mark).toBe(true);
      }
      expect(entries(context(doc))[0]?.mark).toBe(false);
    }
  });
  it("reveals forward, reverse and multiple selections independently", () => {
    const doc = "x &#97; y &#98; z &#99;";
    for (const selection of [
      EditorSelection.single(3, 6),
      EditorSelection.single(6, 3),
      EditorSelection.create([EditorSelection.cursor(3), EditorSelection.cursor(12)]),
    ]) {
      const result = entries(context(doc, selection));
      expect(result[0]?.mark).toBe(true);
      expect(result[2]?.mark).toBe(false);
    }
  });
  it("includes a token crossing a viewport edge and ignores offscreen tokens", () => {
    const doc = "x &#97; y &#98;";
    const c = context(doc);
    c.visibleRanges = [{ from: 4, to: 5 }];
    expect(entries(c).map((e) => doc.slice(e.from, e.to))).toEqual(["&#97;"]);
  });
});
