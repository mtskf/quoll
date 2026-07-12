import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import { extractOutline } from "../../../src/webview/cm/outline/build-outline.js";
import { fullTree } from "../helpers/full-tree.js";

function outline(doc: string) {
  const state = EditorState.create({ doc, extensions: [quollMarkdownLanguage()] });
  return extractOutline(state, fullTree(state));
}

// Project the fields that matter for order/level/text/nesting so assertions
// read clearly; `from` is asserted separately where positional identity matters.
function shape(doc: string) {
  return outline(doc).map((h) => ({ level: h.level, depth: h.depth, text: h.text, line: h.line }));
}

describe("extractOutline", () => {
  it("extracts h1..h6 in document order with level and 1-based line", () => {
    expect(shape("# One\n\ntext\n\n## Two\n\n### Three\n")).toEqual([
      { level: 1, depth: 0, text: "One", line: 1 },
      { level: 2, depth: 1, text: "Two", line: 5 },
      { level: 3, depth: 2, text: "Three", line: 7 },
    ]);
  });

  it("computes nesting depth via a level stack", () => {
    expect(shape("# A\n## B\n### C\n## D\n# E\n")).toEqual([
      { level: 1, depth: 0, text: "A", line: 1 },
      { level: 2, depth: 1, text: "B", line: 2 },
      { level: 3, depth: 2, text: "C", line: 3 },
      { level: 2, depth: 1, text: "D", line: 4 },
      { level: 1, depth: 0, text: "E", line: 5 },
    ]);
  });

  it("collapses skipped levels to contiguous depth", () => {
    expect(shape("# A\n### B\n").map((h) => h.depth)).toEqual([0, 1]);
  });

  it("keeps duplicate heading text as distinct positional entries", () => {
    const out = outline("## Intro\n\n## Intro\n");
    expect(out.map((h) => h.text)).toEqual(["Intro", "Intro"]);
    expect(out[0].from).not.toBe(out[1].from);
    expect(out[0].line).toBe(1);
    expect(out[1].line).toBe(3);
  });

  it("excludes ATX-looking lines inside a fenced code block", () => {
    const doc = "# Real\n\n```\n# Not a heading\n```\n\n## Also Real\n";
    expect(outline(doc).map((h) => h.text)).toEqual(["Real", "Also Real"]);
  });

  it("extracts a heading nested in a blockquote with the container prefix stripped", () => {
    // Verified parser shape: "> # Quoted" => Blockquote > ATXHeading1, node span
    // "# Quoted" (no "> "). A full tree walk + node-span text is required here.
    const out = outline("> # Quoted\n");
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe(1);
    expect(out[0].text).toBe("Quoted");
    expect(out[0].line).toBe(1);
  });

  it("strips a closing hash run and trims", () => {
    expect(outline("## Title ##\n")[0].text).toBe("Title");
  });

  it("accepts up to three leading spaces (ATX indent tolerance)", () => {
    const out = outline("   ## Indented\n");
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe(2);
    expect(out[0].text).toBe("Indented");
  });

  it("returns an empty array when there are no headings", () => {
    expect(outline("just text\n\nmore text\n")).toEqual([]);
  });

  it("sets from to the heading line start (jump target)", () => {
    const state = EditorState.create({
      doc: "intro\n\n## Target\n",
      extensions: [quollMarkdownLanguage()],
    });
    const out = extractOutline(state, fullTree(state));
    expect(out[0].from).toBe(state.doc.line(3).from);
  });
});
