// @vitest-environment happy-dom
// Budget-miss arms of continueListOnEnter's bare-marker empty check, pinned
// without wall-clock: `ensureSyntaxTree` is mocked (module-wide, hence this
// dedicated file) to return null for chosen parse targets and to delegate the
// rest with a generous budget.

import { defaultKeymap } from "@codemirror/commands";
import type * as Language from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

import { listContinuationKeymap } from "../../../src/webview/cm/list/list-continuation-keymap.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";

/** Parse targets (`upto`) that report a budget miss; null = no misses. */
let missWhen: ((state: EditorState, upto: number) => boolean) | null = null;

vi.mock("@codemirror/language", async (importOriginal) => {
  const orig = await importOriginal<typeof Language>();
  return {
    ...orig,
    ensureSyntaxTree: (state: EditorState, upto: number, _timeout?: number) =>
      missWhen?.(state, upto) ? null : orig.ensureSyntaxTree(state, upto, 10_000),
  };
});

afterEach(() => {
  missWhen = null;
});

function pressEnter(doc: string, caret: number): string {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [quollMarkdownLanguage(), listContinuationKeymap(), keymap.of(defaultKeymap)],
    }),
  });
  try {
    view.dispatch({ selection: EditorSelection.cursor(caret) });
    runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    return view.state.doc.toString();
  } finally {
    view.destroy();
  }
}

describe("continueListOnEnter — bare-marker empty check under a budget miss", () => {
  it("exits a truly empty `- ` in one Enter even when the parse never reaches EOF", () => {
    // Every EOF-bounded parse misses: the empty verdict must come from a parse
    // bounded near the caret, however large the unparsed tail below it.
    missWhen = (state, upto) => upto >= state.doc.length;
    const tail = "para line of some text here\n\n".repeat(1000);
    const doc = `- a\n- \n\n${tail}`;
    expect(pressEnter(doc, "- a\n- ".length)).toBe(`- a\n\n\n${tail}`);
  });

  it("keeps the marker (no orphaned body) when the judging parse misses", () => {
    // Miss only the next-line-bounded parse that judges emptiness (line 2's
    // end); the caret-line and EOF parses still succeed.
    const doc = "-\n  text\n\npara";
    missWhen = (state, upto) => upto === state.doc.line(2).to;
    expect(pressEnter(doc, 1)).toBe("-\n- \n  text\n\npara");
  });
});

describe("continueListOnEnter — EOF budget miss across a marker-width change", () => {
  // `9.` → `10. ` moves the content column, so the body must shift with it.
  // Without the EOF tree the shift cannot be computed: Enter must leave the
  // doc untouched (not insert `10. ` and orphan the body as a paragraph).
  it.each([
    ["bare marker owning a body", "9.\n   body\n\npara", 2],
    ["item with content and a body", "9. a\n   body", 4],
  ])("does not orphan the body (%s)", (_label, doc, caret) => {
    missWhen = (state, upto) => upto >= state.doc.length;
    expect(pressEnter(doc, caret)).toBe(doc);
  });

  it("still inserts when the content column does not move (`- a`)", () => {
    missWhen = (state, upto) => upto >= state.doc.length;
    expect(pressEnter("- a\n  body", 3)).toBe("- a\n- \n  body");
  });
});
