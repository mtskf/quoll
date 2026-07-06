// @vitest-environment happy-dom
// test/webview/cm-fenced-code-body.test.ts
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  fencedCodeBlockRevealed,
  fencedCodeFenceLandmarks,
} from "../../src/webview/cm/fenced-code/fenced-code-body.js";
import { fullTree } from "./helpers/full-tree.js";

type SyntaxNode = ReturnType<typeof fullTree>["topNode"];

function firstFencedCode(doc: string): { state: EditorState; node: SyntaxNode } {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const tree = fullTree(state);
  let found: SyntaxNode | null = null;
  tree.iterate({
    enter: (n) => {
      if (found === null && n.name === "FencedCode") {
        found = n.node;
      }
    },
  });
  if (found === null) {
    throw new Error("no FencedCode node in fixture");
  }
  return { state, node: found };
}

describe("fencedCodeFenceLandmarks", () => {
  it("pins open/close fence lines + body span for a CLOSED block with a lang tag", () => {
    // line 1 = ```js, lines 2-3 = body, line 4 = ```
    const { state, node } = firstFencedCode("```js\nconst x = 1;\nfoo();\n```\n");
    expect(fencedCodeFenceLandmarks(state.doc, node)).toEqual({
      openFenceLine: 1,
      closeFenceLine: 4,
      bodyStartLine: 2,
      bodyEndLine: 3,
    });
  });

  it("pins landmarks for an UNCLOSED block at EOF (no close fence; body runs to last line)", () => {
    // line 1 = ```js, lines 2-3 = body, no closing fence
    const { state, node } = firstFencedCode("```js\nconst x = 1;\nfoo();");
    expect(fencedCodeFenceLandmarks(state.doc, node)).toEqual({
      openFenceLine: 1,
      closeFenceLine: null,
      bodyStartLine: 2,
      bodyEndLine: 3,
    });
  });

  it("pins landmarks for a BODYLESS block (open + close fence, no body lines)", () => {
    // line 1 = ```, line 2 = ``` — close fence present, body span null.
    const { state, node } = firstFencedCode("```\n```\n");
    expect(fencedCodeFenceLandmarks(state.doc, node)).toEqual({
      openFenceLine: 1,
      closeFenceLine: 2,
      bodyStartLine: null,
      bodyEndLine: null,
    });
  });

  it("handles a tilde fence (single body line, closed)", () => {
    const { state, node } = firstFencedCode("~~~\nplain\n~~~\n");
    expect(fencedCodeFenceLandmarks(state.doc, node)).toEqual({
      openFenceLine: 1,
      closeFenceLine: 3,
      bodyStartLine: 2,
      bodyEndLine: 2,
    });
  });
});

describe("fencedCodeBlockRevealed", () => {
  const build = (doc: string, caret: number) => {
    const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
    const node = fullTree(state).topNode.getChild("FencedCode");
    if (node === null) {
      throw new Error("no FencedCode node");
    }
    return fencedCodeBlockRevealed(state.doc, EditorSelection.single(caret), node);
  };
  // L1 "```js"[0,5] L2 "const x = 1;"[6,18] L3 "```"[19,22]
  const doc = "```js\nconst x = 1;\n```";

  it("caret in the CODE BODY reveals the block", () => {
    expect(build(doc, 10)).toBe(true); // inside "const x = 1;"
  });
  it("caret ON either fence line reveals the block", () => {
    expect(build(doc, 2)).toBe(true); // in "```js"
    expect(build(doc, 20)).toBe(true); // in closing "```"
  });
  it("caret OUTSIDE the block does NOT reveal", () => {
    const d = `${doc}\n\npara`;
    expect(build(d, d.indexOf("para") + 1)).toBe(false);
  });
  it("unclosed block at EOF: body caret reveals", () => {
    expect(build("```js\nconst x = 1;", 10)).toBe(true);
  });
});
