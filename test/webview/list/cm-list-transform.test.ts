// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  classifyItemLines,
  formatMarker,
  parseListMark,
} from "../../../src/webview/cm/list/list-transform.js";

function forceParse(view: EditorView): EditorView {
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

function mount(
  doc: string,
  selection: EditorSelection | SelectionRange,
  opts: { readOnly?: boolean } = {}
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.readOnly.of(opts.readOnly ?? false),
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

// Resolves the `ListItem` enclosing line `n`'s first non-whitespace column,
// walking up from the syntax tree's innermost node — same probe strategy as
// list-tree.ts's listItemAt, duplicated here (test-only) to avoid coupling
// this classifier test to the caret-resolution module.
function resolveItemAtLine(
  state: EditorState,
  n: number
): ReturnType<typeof syntaxTree>["topNode"] {
  const line = state.doc.line(n);
  const wsLen = line.text.length - line.text.trimStart().length;
  let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(
    line.from + wsLen,
    1
  );
  while (node !== null) {
    if (node.name === "ListItem") {
      return node;
    }
    node = node.parent;
  }
  throw new Error(`no ListItem found at line ${n}`);
}

describe("parseListMark", () => {
  it("classifies bullet glyphs", () => {
    expect(parseListMark("-")).toEqual({ kind: "bullet", glyph: "-" });
    expect(parseListMark("*")).toEqual({ kind: "bullet", glyph: "*" });
    expect(parseListMark("+")).toEqual({ kind: "bullet", glyph: "+" });
  });
  it("classifies ordered markers, multi-digit, both delimiters", () => {
    expect(parseListMark("1.")).toEqual({ kind: "ordered", number: 1, delim: "." });
    expect(parseListMark("10)")).toEqual({ kind: "ordered", number: 10, delim: ")" });
    expect(parseListMark("999999999.")).toEqual({ kind: "ordered", number: 999999999, delim: "." });
  });
  it("rejects a 10+-digit run (Lezer does not treat it as a ListMark)", () => {
    expect(parseListMark("1234567890.")).toBeNull();
  });
  it("returns null on non-marker text", () => {
    expect(parseListMark("x")).toBeNull();
  });
});

describe("formatMarker", () => {
  it("round-trips (zero-pad width not preserved — plain decimal)", () => {
    expect(formatMarker({ kind: "bullet", glyph: "*" })).toBe("*");
    expect(formatMarker({ kind: "ordered", number: 3, delim: ")" })).toBe("3)");
  });
});

describe("classifyItemLines", () => {
  it("classifyItemLines splits marker vs own body and drops the lazy tail", () => {
    // Broken 2-space doc: "- ddd" swallows "3. ddd\n4. ddd" as a lazy paragraph.
    const view = mount("1. a\n2. b\n  - ddd\n3. ddd\n4. ddd", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 3); // the "  - ddd" ListItem
      const { markerLine, ownLines } = classifyItemLines(view.state, item);
      expect(markerLine).toBe(3);
      expect(ownLines).toEqual([]); // 3./4. are lazy (col 0 < content col) → excluded
    } finally {
      view.destroy();
    }
  });
  it("classifyItemLines keeps a genuinely nested child line", () => {
    const view = mount("- a\n  - child", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1); // "- a"
      const { markerLine, ownLines } = classifyItemLines(view.state, item);
      expect(markerLine).toBe(1);
      expect(ownLines).toEqual([2]); // "  - child" col 2 ≥ content col 2 → own
    } finally {
      view.destroy();
    }
  });
});
