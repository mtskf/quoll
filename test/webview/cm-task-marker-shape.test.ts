import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  isContentlessTaskParagraph,
  TASK_MARKER_RE,
} from "../../src/webview/cm/task-checkbox/task-marker-shape.js";
import { fullTree } from "./helpers/full-tree.js";

function firstParagraphAt(doc: string, at: number) {
  const state = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })] });
  const tree = fullTree(state);
  let node: ReturnType<typeof tree.resolveInner> | null = null;
  tree.iterate({
    enter: (n) => {
      if (n.name === "Paragraph" && n.from <= at && at < n.to) {
        node = n.node;
      }
    },
  });
  return { state, node: node! };
}

describe("task-marker-shape", () => {
  it("TASK_MARKER_RE matches [ ] / [x] / [X] only", () => {
    expect(TASK_MARKER_RE.test("[ ]")).toBe(true);
    expect(TASK_MARKER_RE.test("[x]")).toBe(true);
    expect(TASK_MARKER_RE.test("[X]")).toBe(true);
    expect(TASK_MARKER_RE.test("[ ]x")).toBe(false);
    expect(TASK_MARKER_RE.test("()")).toBe(false);
  });

  it("true for a first-content bare marker `- [ ]`", () => {
    const { state, node } = firstParagraphAt("- [ ]", 2);
    expect(isContentlessTaskParagraph(state, node)).toBe(true);
  });

  it("FALSE for a trailing `[ ]` paragraph that is NOT first content (`- first\\n\\n  [ ]`)", () => {
    const { state, node } = firstParagraphAt("- first\n\n  [ ]", 11);
    expect(isContentlessTaskParagraph(state, node)).toBe(false);
  });

  it("FALSE for a plain paragraph `- foo`", () => {
    const { state, node } = firstParagraphAt("- foo", 2);
    expect(isContentlessTaskParagraph(state, node)).toBe(false);
  });
});
