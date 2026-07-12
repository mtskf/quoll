import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { inlineMarkReveal } from "../../../src/webview/cm/decorations/inline-mark-reveal.js";
import type { BuildContext } from "../../../src/webview/cm/decorations/types.js";
import { fullTree } from "../helpers/full-tree.js";

function ctx(doc: string, selection: EditorSelection): BuildContext {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return {
    state,
    selection,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

function shape(set: DecorationSet): Array<{ from: number; to: number; kind: "mark" | "replace" }> {
  const out: Array<{ from: number; to: number; kind: "mark" | "replace" }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const cls = (iter.value.spec as { class?: string }).class;
    out.push({ from: iter.from, to: iter.to, kind: cls === undefined ? "replace" : "mark" });
    iter.next();
  }
  return out;
}

describe("inline-mark reveal provider", () => {
  it("hides both `**` marks of a Strong span when caret is outside", () => {
    const doc = "**bold** rest";
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(doc.length)));
    const ranges = shape(set);
    // Two replaces: the opening `**` and the closing `**`.
    expect(ranges.length).toBe(2);
    expect(ranges.every((r) => r.kind === "replace")).toBe(true);
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(2);
    expect(ranges[1]?.from).toBe(6);
    expect(ranges[1]?.to).toBe(8);
  });

  it("reveals both `**` marks when caret is INSIDE the Strong span", () => {
    const doc = "**bold** rest";
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(4))); // in "bold"
    const ranges = shape(set);
    expect(ranges.length).toBe(2);
    expect(ranges.every((r) => r.kind === "mark")).toBe(true);
  });

  it("reveals the `**` marks when caret is AT the closing boundary (inclusive)", () => {
    const doc = "**bold**";
    // Caret at offset 8 = just after the closing `**`. Inclusive boundary
    // = REVEAL (so the next keystroke, which would land inside, sees marks
    // already shown). This matches Obsidian Live Preview behaviour.
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(8)));
    const ranges = shape(set);
    expect(ranges.length).toBe(2);
    expect(ranges.every((r) => r.kind === "mark")).toBe(true);
  });

  it("handles Emphasis (`*x*` and `_x_`) — both delimiters", () => {
    // Caret at doc.length on a single-line doc would sit at the END of the
    // last Emphasis span (boundary-inclusive intersect = INSIDE), revealing
    // it. Use a trailing paragraph with the cursor inside.
    const doc = "*a* and _b_\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = shape(set);
    expect(ranges.length).toBe(4);
    expect(ranges.every((r) => r.kind === "replace")).toBe(true);
  });

  it("handles InlineCode (`` ` ``) — both backticks", () => {
    // Caret at 0 = start of "use", offset before the InlineCode span [4, 9).
    // Half-open intersect: caret r=[0,0]; r.to=0 < node.from=4 → NOT inside.
    const doc = "use `var` here";
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(0)));
    const ranges = shape(set);
    expect(ranges.length).toBe(2);
    expect(ranges[0]?.from).toBe(4); // opening backtick
    expect(ranges[0]?.to).toBe(5);
    expect(ranges[1]?.from).toBe(8); // closing backtick
    expect(ranges[1]?.to).toBe(9);
    expect(ranges.every((r) => r.kind === "replace")).toBe(true);
  });

  it("handles Strikethrough (`~~`) — GFM", () => {
    // Caret at 0 sat at the start of the Strikethrough span [0, 11)
    // (boundary-inclusive = INSIDE), revealing it. Use a leading paragraph
    // and place the caret in it instead.
    const doc = "paragraph\n\n~~deleted~~";
    const caret = 3; // inside "paragraph"
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = shape(set);
    expect(ranges.length).toBe(2);
    // Strikethrough opens at offset 11 (after "paragraph\n\n"), so the
    // marks land at [11, 13) and [20, 22).
    expect(ranges.every((r) => r.kind === "replace")).toBe(true);
  });

  it("caret in inner span reveals BOTH outer (Strong) and inner (Emphasis) — every ancestor span the caret intersects reveals", () => {
    // "**bold *italic* end**"
    //  012345678901234567890
    //  Outer Strong: [0, 21)  marks: [0,2) and [19,21)
    //  Inner Emphasis: [7, 15) marks: [7,8) and [14,15)
    const doc = "**bold *italic* end**";
    // Caret in "italic" → BOTH outer Strong AND inner Emphasis contain it.
    // The Lezer tree nesting gives the contract "if any ancestor span
    // contains the caret, its marks reveal" — so all 4 marks reveal.
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(10)));
    const ranges = shape(set);
    expect(ranges.length).toBe(4);
    expect(ranges.every((r) => r.kind === "mark")).toBe(true);
  });

  it("nested Strong > Emphasis: caret OUTSIDE outer → ALL marks hide", () => {
    const doc = "**bold *italic* end** after";
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(doc.length)));
    const ranges = shape(set);
    expect(ranges.length).toBe(4);
    expect(ranges.every((r) => r.kind === "replace")).toBe(true);
  });

  it("nested Strong > Emphasis: caret INSIDE outer but OUTSIDE inner → only outer reveals, inner hides", () => {
    // "**bold *italic* end**"
    //  0123456                14   19
    // Caret at offset 4 = in "bold" — inside Strong [0, 21), outside Emphasis [7, 15).
    const doc = "**bold *italic* end**";
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(4)));
    const ranges = shape(set);
    // 4 decorations total: 2 mark (Strong's `**`), 2 replace (Emphasis's `*`).
    expect(ranges.length).toBe(4);
    const marks = ranges.filter((r) => r.kind === "mark");
    const replaces = ranges.filter((r) => r.kind === "replace");
    expect(marks.length).toBe(2);
    expect(replaces.length).toBe(2);
  });

  it("emits two replaces for an InlineCode span when no caret is inside (caret in a trailing paragraph)", () => {
    // The earlier fixture used `single(10)` on a 5-char doc —
    // EditorState.create THREW at fixture build, the assertion never ran.
    // Caret in the trailing paragraph keeps the cursor in-range AND clearly
    // outside the InlineCode span.
    const doc = "`raw`\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = inlineMarkReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = shape(set);
    expect(ranges.length).toBe(2);
    expect(ranges.every((r) => r.kind === "replace")).toBe(true);
  });

  it("identity round-trip: ctx.state.doc is never mutated", () => {
    const doc = "**bold** *italic* `code` ~~strike~~";
    const c = ctx(doc, EditorSelection.single(4));
    const before = c.state.doc.toString();
    inlineMarkReveal.build(c);
    expect(c.state.doc.toString()).toBe(before);
  });
});
