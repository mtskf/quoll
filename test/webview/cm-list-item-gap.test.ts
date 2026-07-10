// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { quollFolding } from "../../src/webview/cm/fold/index.js";
import { listHangIndent } from "../../src/webview/cm/list/list-hang-indent.js";
import { quollTheme } from "../../src/webview/cm/theme.js";

// The list-item vertical gap is UNIFORM (2026-07-10): every renderable list-item
// MARKER line carries `.quoll-list-hang` (→ `--quoll-list-item-gap` padding-top),
// so bullet / ordered / task lists never render packed. The former per-boundary
// `listItemGetsVerticalGap` predicate (which dropped the gap for tight consecutive
// siblings) was removed; `isRenderableListItem` is now the single gate driving BOTH
// the content-line padding AND the fold-gutter offset. happy-dom has no layout, so
// these assert the CLASS/marker set (the pixel gap is real-browser-only).

function render(doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
        listHangIndent,
        quollTheme,
      ],
    }),
    parent,
  });
  forceParsing(view as unknown as never, view.state.doc.length, 5_000);
  const lines = [...view.dom.querySelectorAll(".cm-line")].map((l) => ({
    text: l.textContent,
    hang: l.className.includes("quoll-list-hang"),
    hasIndentStyle: (l.getAttribute("style") ?? "").includes("padding-inline-start"),
  }));
  view.destroy();
  return lines;
}

describe("list-hang render — uniform vertical gap", () => {
  it("tight siblings: EVERY item carries quoll-list-hang (no packing)", () => {
    const lines = render("- a\n- b\n- c").filter((l) => l.text !== "");
    expect(lines.map((l) => l.hang)).toEqual([true, true, true]);
    expect(lines.every((l) => l.hasIndentStyle)).toBe(true); // horizontal hang preserved
  });
  it("checkbox Enter-continuation: the second task item also carries the gap", () => {
    const lines = render("- [ ] test\n- [ ] ddd").filter((l) => l.text !== "");
    expect(lines.map((l) => l.hang)).toEqual([true, true]);
  });
  it("loose list keeps the gap on every item", () => {
    const lines = render("- a\n\n- b").filter((l) => l.text !== "");
    expect(lines.map((l) => l.hang)).toEqual([true, true]);
  });
  it("nested tight children carry the gap (the `Done when:` sub-bullet case)", () => {
    const lines = render("- parent\n  - child one\n  - child two").filter((l) => l.text !== "");
    expect(lines.map((l) => l.hang)).toEqual([true, true, true]);
  });
  it("INDENTED tight siblings carry the gap", () => {
    const lines = render("  - a\n  - b\n  - c").filter((l) => l.text !== "");
    expect(lines.map((l) => l.hang)).toEqual([true, true, true]);
  });
  it("continuation lines (not marker lines) do NOT carry the gap", () => {
    // "- a\n  cont\n- b": line 2 "  cont" is an intra-item continuation, not a
    // ListItem marker — it gets neither the class nor the hang inline style.
    const lines = render("- a\n  cont\n- b").filter((l) => l.text !== "");
    expect(lines.map((l) => ({ hang: l.hang, indent: l.hasIndentStyle }))).toEqual([
      { hang: true, indent: true }, // "- a" marker
      { hang: false, indent: false }, // "  cont" continuation
      { hang: true, indent: true }, // "- b" marker
    ]);
  });
});

function mountWithGutter(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(0),
      extensions: [
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
        listHangIndent,
        quollFolding(),
        quollTheme,
      ],
    }),
    parent,
  });
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

/** Booleans: does each list line carry the content gap-class, and how many gutter
 *  list-marker elements carry the offset. Blank lines are excluded on the content
 *  side (no list line) and absent on the gutter side. */
function contentVsGutter(view: EditorView) {
  const content = [...view.dom.querySelectorAll(".cm-content .cm-line")]
    .filter((l) => l.textContent !== "")
    .map((l) => l.className.includes("quoll-list-hang"));
  const gutter = [
    ...view.dom.querySelectorAll(".cm-foldGutter .cm-gutterElement.quoll-fold-list-marker"),
  ].map(() => true); // presence == has-offset; compare COUNT + positions below
  return { content, gutterCount: gutter.length };
}

describe("fold gutter lock-step (uniform gap)", () => {
  it("tight list: every marker line gets a gutter offset, matching the content gap-class count", () => {
    const view = mountWithGutter("- a\n- b\n- c");
    const { content, gutterCount } = contentVsGutter(view);
    view.destroy();
    expect(content).toEqual([true, true, true]); // every item carries the gap
    expect(gutterCount).toBe(content.filter(Boolean).length); // 3 offsets, matching 3 gap lines
  });

  it("bounded-recompute: deleting the blank line between a loose pair keeps content + gutter in lock-step", () => {
    const view = mountWithGutter("- a\n\n- b");
    // Initially loose — both items carry the gap on both sides.
    const before = contentVsGutter(view);
    expect(before.content).toEqual([true, true]);
    expect(before.gutterCount).toBe(2);

    // Delete the blank line (a NEWLINE-DELTA structural edit → full rebuild on
    // both sides), collapsing the pair into a tight boundary. Under the uniform
    // gap the tagging does NOT change — both items stay tagged — but the
    // bounded-recompute must still keep content + gutter counts consistent.
    const blankLine = view.state.doc.line(2);
    view.dispatch({ changes: { from: blankLine.from, to: blankLine.to + 1, insert: "" } });
    forceParsing(view, view.state.doc.length, 5_000);

    const after = contentVsGutter(view);
    view.destroy();
    expect(after.content).toEqual([true, true]); // both still carry the gap
    expect(after.gutterCount).toBe(2); // gutter stays in lock-step
  });
});
