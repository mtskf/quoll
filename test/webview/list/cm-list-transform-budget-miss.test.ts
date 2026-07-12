// @vitest-environment happy-dom
//
// Isolated file: it mocks `@codemirror/language`'s `ensureSyntaxTree` to force
// the EOF-parse-budget-miss branch (return null) that the planner treats as a
// speculative, fail-closed no-op ("never throw, never corrupt"). All other
// tests reach EOF via forceParsing, so this branch is otherwise unobserved —
// a future rewrite of the fail-close to an early-return could run the planner
// over a null/broken tree and emit a corrupt change while the suite stayed
// green. The mock is scoped to THIS file (vitest module mocks are per-file) so
// it never leaks into the real-tree transform tests; only `ensureSyntaxTree` is
// overridden, every other `@codemirror/language` export stays real.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Override ONLY ensureSyntaxTree; keep forceParsing / syntaxTree / markdown
// parsing real so we can build a genuinely-parsed doc and item node, then force
// the planner's own EOF re-parse to miss.
vi.mock("@codemirror/language", async (importActual) => {
  const actual = await importActual<typeof import("@codemirror/language")>();
  return { ...actual, ensureSyntaxTree: vi.fn(() => null) };
});

import { outdentListItem } from "../../../src/webview/cm/list/list-indent-keymap.js";
import { renumberRun } from "../../../src/webview/cm/list/list-transform.js";

function mount(doc: string, headLine: number): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(0),
    extensions: [markdown({ base: markdownLanguage })],
  });
  const view = new EditorView({ state, parent });
  // Real EOF parse so the doc is fully structured BEFORE the mocked
  // ensureSyntaxTree null forces the planner's re-parse to fail closed.
  forceParsing(view, view.state.doc.length, 5_000);
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(headLine).to) });
  return view;
}

function resolveItemAtLine(state: EditorState, n: number) {
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
  throw new Error(`no ListItem at line ${n}`);
}

describe("EOF budget miss (ensureSyntaxTree null) fail-closed no-op", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renumberRun returns [] (no change) when the EOF re-parse misses", () => {
    const view = mount("1. a\n2. b\n3. c", 1);
    try {
      const a = resolveItemAtLine(view.state, 1);
      // With a real tree this would renumber the followers; the null tree fails
      // closed to [] — an empty, non-corrupting change set.
      expect(renumberRun(view.state, a, 5)).toEqual([]);
    } finally {
      view.destroy();
    }
  });

  it("outdentListItem is a doc-unchanged, no-throw no-op when the EOF re-parse misses", () => {
    const view = mount("- a\n  - b", 2);
    const before = view.state.doc.toString();
    try {
      // resolveItemAtEof sees a null tree -> planner returns { kind: "noop" } ->
      // the keymap dispatches nothing. No throw, doc byte-identical.
      expect(() => outdentListItem(view)).not.toThrow();
      expect(view.state.doc.toString()).toBe(before);
    } finally {
      view.destroy();
    }
  });
});
