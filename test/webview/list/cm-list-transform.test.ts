// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  classifyItemLines,
  continuationMarkerFor,
  formatMarker,
  isEmptyItem,
  parseListMark,
  renumberRun,
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

describe("renumberRun", () => {
  it("re-indents a widened sibling's nested child (9. -> 10.)", () => {
    const view = mount("8. a\n9. b\n   - child\n", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1); // "8. a"
      // Renumber followers of "8. a" from 10: "9. b" -> "10. b" (width 1->2),
      // so its child "   - child" gains one leading space -> "    - child".
      view.dispatch({ changes: renumberRun(view.state, a, 10) });
      expect(view.state.doc.toString()).toBe("8. a\n10. b\n    - child\n");
    } finally {
      view.destroy();
    }
  });

  it("preserves the run's `)` delimiter while renumbering", () => {
    // CommonMark requires a uniform delimiter within one OrderedList (a mixed
    // delimiter starts a NEW list, so a genuine Lezer-sibling run always shares
    // one delimiter) — this pins that renumberRun reads each sibling's OWN
    // delimiter from its marker rather than hard-coding "." .
    const view = mount("1) a\n2) b\n3) c", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      view.dispatch({ changes: renumberRun(view.state, a, 5) });
      expect(view.state.doc.toString()).toBe("1) a\n5) b\n6) c");
    } finally {
      view.destroy();
    }
  });

  it("does not touch a following sibling's own width when width is unchanged", () => {
    const view = mount("1. a\n2. b\nlazy line\n3. c", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      view.dispatch({ changes: renumberRun(view.state, a, 2) });
      expect(view.state.doc.toString()).toBe("1. a\n2. b\nlazy line\n3. c");
    } finally {
      view.destroy();
    }
  });

  it("fails closed (returns []) when a new number would exceed 9 digits", () => {
    const view = mount("1. a\n2. b\n", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      const changes = renumberRun(view.state, a, 1_000_000_000);
      expect(changes).toEqual([]);
    } finally {
      view.destroy();
    }
  });
});

describe("continuationMarkerFor", () => {
  it("builds a bullet marker", () => {
    const view = mount("- a", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(continuationMarkerFor(view.state, item)).toBe("- ");
    } finally {
      view.destroy();
    }
  });

  it("builds an incremented ordered marker, preserving the delimiter", () => {
    const view = mount("1) a", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(continuationMarkerFor(view.state, item)).toBe("2) ");
    } finally {
      view.destroy();
    }
  });

  it("appends an always-unchecked task marker for a task predecessor", () => {
    const view = mount("- [x] done", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(continuationMarkerFor(view.state, item)).toBe("- [ ] ");
    } finally {
      view.destroy();
    }
  });
});

describe("isEmptyItem", () => {
  it("is true for a bare bullet marker", () => {
    const view = mount("- ", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(isEmptyItem(view.state, item)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("is true for a content-less `[ ]` task Paragraph", () => {
    const view = mount("- [ ]", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(isEmptyItem(view.state, item)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("is true for a whitespace-only Task", () => {
    const view = mount("- [ ] ", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(isEmptyItem(view.state, item)).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("is false for a non-empty item", () => {
    const view = mount("- a", EditorSelection.cursor(0));
    try {
      const item = resolveItemAtLine(view.state, 1);
      expect(isEmptyItem(view.state, item)).toBe(false);
    } finally {
      view.destroy();
    }
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
