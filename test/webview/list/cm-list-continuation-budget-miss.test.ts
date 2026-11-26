// @vitest-environment happy-dom
// Budget-miss arms of continueListOnEnter, pinned as a decision table (which
// document each branch returns, and which parse requests it makes) without
// wall-clock: `ensureSyntaxTree` is mocked (module-wide, hence this dedicated
// file) to return null for chosen parse targets and to delegate the rest with a
// generous budget. Misses are injected independently per request, so not every
// row is a sequence the real editor reaches.

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

  it("exits a bare marker on the last line with no further request", () => {
    // No line below, so the caret-bounded item is complete: judged as is.
    missWhen = (state, upto) => upto >= state.doc.length;
    expect(pressEnter("- a\n- ", "- a\n- ".length)).toBe("- a\n");
  });

  // Emptiness unknown: neither exit (could orphan a body) nor continue (could
  // add a marker under an empty item), and nothing more is requested.
  it.each([
    ["a body-owning marker", "-\n  text\n\npara", 1],
    ["an empty marker", "- \n\npara", 2],
  ])("makes no edit when the judging parse misses (%s)", (_label, doc, caret) => {
    let eofRequests = 0;
    missWhen = (state, upto) => {
      if (upto >= state.doc.length) {
        eofRequests++;
      }
      return upto === state.doc.line(2).to;
    };
    expect(pressEnter(doc, caret)).toBe(doc);
    expect(eofRequests).toBe(0);
  });
});

describe("continueListOnEnter — marker-line decisions request no EOF parse", () => {
  // Only an edit that lands needs the tree past the caret line. Every EOF request
  // misses here, so a request would also turn the expected edit into a no-op.
  it.each([
    ["exits an empty task", "- [ ] \n\npara", "- [ ] ".length, "\n\npara"],
    ["defers inside the checkbox", "- [x] a\n\npara", "- [".length, "- [\nx] a\n\npara"],
  ])("%s", (_label, doc, caret, out) => {
    let eofRequests = 0;
    missWhen = (state, upto) => {
      if (upto >= state.doc.length) {
        eofRequests++;
        return true;
      }
      return false;
    };
    expect(pressEnter(doc, caret)).toBe(out);
    expect(eofRequests).toBe(0);
  });
});

describe("continueListOnEnter — EOF budget miss across a marker-width change", () => {
  // `9.` → `10. ` moves the content column, so the body must shift with it.
  // Without a tree that shows the item closed the shift cannot be computed:
  // Enter must leave the doc untouched (not insert `10. ` and orphan the body
  // as a paragraph).
  it.each([
    ["bare marker owning a body", "9.\n   body", 2],
    ["item with content and a body", "9. a\n   body", 4],
  ])("does not orphan the body (%s)", (_label, doc, caret) => {
    missWhen = (state, upto) => upto >= state.doc.length;
    expect(pressEnter(doc, caret)).toBe(doc);
  });

  // A node after the item within the bounded lookahead proves it closed, so its
  // own lines shift from that tree; only the renumber (it needs EOF) is skipped.
  const tail = "para line of some text here\n\n".repeat(1000);
  it.each([
    ["a heading right below", `9. a\n# H\n${tail}`, `9. a\n10. \n# H\n${tail}`],
    ["a body, then a heading", `9. a\n   body\n# H\n${tail}`, `9. a\n10. \n    body\n# H\n${tail}`],
  ])("still inserts `10. ` when a bounded parse closes the item (%s)", (_l, doc, out) => {
    missWhen = (state, upto) => upto >= state.doc.length;
    expect(pressEnter(doc, 4)).toBe(out);
  });

  it("does not shift a body the bounded parse cannot see the end of", () => {
    // No node after the item in the tree the request returned, so nothing
    // proves it closed: shifting the visible part only would split the body.
    missWhen = (state, upto) => upto >= state.doc.length;
    const doc = `9. a\n${"   body\n".repeat(3000)}# H\n${tail}`;
    expect(pressEnter(doc, 4)).toBe(doc);
  });

  // The closure request stops at the last complete line within the ceiling, so a
  // long final line cannot push it to EOF (the parse that just missed).
  const longLine = "x".repeat(30_000);
  it.each([
    ["a heading right below", `9. a\n# H\n${longLine}`, `9. a\n10. \n# H\n${longLine}`],
    [
      "a body, then a heading",
      `9. a\n   body\n# H\n${longLine}`,
      `9. a\n10. \n    body\n# H\n${longLine}`,
    ],
  ])("inserts `10. ` before a long final line (%s)", (_l, doc, out) => {
    missWhen = (state, upto) => upto >= state.doc.length;
    expect(pressEnter(doc, 4)).toBe(out);
  });

  it("makes no edit when only a long final line follows the item", () => {
    missWhen = (state, upto) => upto >= state.doc.length;
    const doc = `9. a\n${longLine}`;
    expect(pressEnter(doc, 4)).toBe(doc);
  });

  it("makes no edit when a bare new marker would sit above a blank line", () => {
    // Without the item's lines the blank-separated body cannot be kept under the
    // new marker (a bare marker owns only a block directly below it).
    missWhen = (state, upto) => upto >= state.doc.length;
    const doc = "- a\n\n  - child";
    expect(pressEnter(doc, 3)).toBe(doc);
  });

  it("still inserts when the content column does not move (`- a`)", () => {
    missWhen = (state, upto) => upto >= state.doc.length;
    expect(pressEnter("- a\n  body", 3)).toBe("- a\n- \n  body");
  });
});
