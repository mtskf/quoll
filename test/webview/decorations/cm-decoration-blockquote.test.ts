import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { blockquoteReveal } from "../../../src/webview/cm/decorations/blockquote-reveal.js";
import type { BuildContext } from "../../../src/webview/cm/decorations/types.js";
import { fullTree } from "../helpers/full-tree.js";

function ctx(
  doc: string,
  selection: EditorSelection,
  visibleRange?: { from: number; to: number }
): BuildContext {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return {
    state,
    selection,
    visibleRanges: [visibleRange ?? { from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

function tagsOf(set: DecorationSet): Array<{ from: number; to: number; kind: "mark" | "replace" }> {
  const out: Array<{ from: number; to: number; kind: "mark" | "replace" }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const cls = (iter.value.spec as { class?: string }).class;
    out.push({ from: iter.from, to: iter.to, kind: cls === undefined ? "replace" : "mark" });
    iter.next();
  }
  return out;
}

describe("blockquote reveal provider", () => {
  it("HIDE: replace range covers `> ` (mark + trailing space) when caret is outside", () => {
    const doc = "> quoted\nparagraph";
    const set = blockquoteReveal.build(ctx(doc, EditorSelection.single(15))); // in "paragraph"
    const ranges = tagsOf(set);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.kind).toBe("replace");
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(2); // `>` + trailing space
  });

  it("HIDE: absorbs a TAB between `>` and content (`>\\tquote`)", () => {
    // Previously the helper consumed only a SINGLE space; `>\tquote` left
    // a phantom tab in the rendered output. The fix consumes all
    // consecutive spaces/tabs between the mark and the content.
    const doc = ">\tquote\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = blockquoteReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = tagsOf(set);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.kind).toBe("replace");
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(2); // `>` + 1 tab
  });

  it("HIDE: absorbs MULTIPLE structural spaces (`>  quote`)", () => {
    const doc = ">  quote\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = blockquoteReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = tagsOf(set);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.kind).toBe("replace");
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(3); // `>` + 2 spaces
  });

  it("REVEAL: mark range covers only `>` (NOT trailing space) when caret on the line", () => {
    const doc = "> quoted\nparagraph";
    const set = blockquoteReveal.build(ctx(doc, EditorSelection.single(4))); // in "quoted"
    const ranges = tagsOf(set);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.kind).toBe("mark");
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(1);
  });

  it("nested `> >`: each level emits its own decoration, both line-keyed", () => {
    // Append a non-blockquote paragraph + put the caret INSIDE it so the
    // blockquote line has no selection. The earlier single-line
    // `"> > nested"` with `selection(doc.length)` sat the caret on the only
    // line and produced two REVEAL marks, not the asserted two HIDE marks.
    const doc = "> > nested\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = blockquoteReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = tagsOf(set);
    expect(ranges.length).toBe(2);
    expect(ranges.every((r) => r.kind === "replace")).toBe(true);
  });

  it("nested `> >` with caret in content → BOTH marks reveal (caret is on the same line)", () => {
    const doc = "> > nested";
    const set = blockquoteReveal.build(ctx(doc, EditorSelection.single(8))); // in "nested"
    const ranges = tagsOf(set);
    expect(ranges.length).toBe(2);
    expect(ranges.every((r) => r.kind === "mark")).toBe(true);
  });

  it("PER-LINE REVEAL TRIGGER: multi-line blockquote → caret on line 2 reveals ONLY line 2's mark", () => {
    // "> line 1\n> line 2\n> line 3"
    const doc = "> line 1\n> line 2\n> line 3";
    // Caret on line 2's "line".
    const sel = EditorSelection.single("> line 1\n> li".length);
    const set = blockquoteReveal.build(ctx(doc, sel));
    const ranges = tagsOf(set);
    expect(ranges.length).toBe(3);
    // Line 1 mark: hide. Line 2 mark: reveal. Line 3 mark: hide.
    expect(ranges[0]?.kind).toBe("replace");
    expect(ranges[1]?.kind).toBe("mark");
    expect(ranges[2]?.kind).toBe("replace");
  });

  it("respects visibleRanges: mark on line 3 is NOT emitted when viewport ends at line 2", () => {
    const doc = "> line 1\n> line 2\n> line 3";
    // Viewport covers lines 1+2 only (offset 0 .. end-of-line-2).
    const vrTo = "> line 1\n> line 2".length;
    const set = blockquoteReveal.build(ctx(doc, EditorSelection.single(0), { from: 0, to: vrTo }));
    const ranges = tagsOf(set);
    expect(ranges.length).toBe(2); // only line 1 + line 2
  });

  it("emits nothing for non-blockquote content", () => {
    const doc = "just a paragraph\n# heading";
    const set = blockquoteReveal.build(ctx(doc, EditorSelection.single(0)));
    expect(set.size).toBe(0);
  });

  it("identity round-trip: ctx.state.doc is never mutated", () => {
    const doc = "> q\nparagraph";
    const c = ctx(doc, EditorSelection.single(0));
    const before = c.state.doc.toString();
    blockquoteReveal.build(c);
    expect(c.state.doc.toString()).toBe(before);
  });
});
