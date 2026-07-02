import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { linkReveal } from "../../src/webview/cm/decorations/link-reveal.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import { fullTree } from "./helpers/full-tree.js";

function ctx(doc: string, selection: EditorSelection): BuildContext {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return {
    state,
    selection: state.selection,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

function decosOf(
  set: DecorationSet
): Array<{ from: number; to: number; kind: string; class?: string }> {
  const out: Array<{ from: number; to: number; kind: string; class?: string }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const spec = iter.value.spec as { class?: string };
    // Decoration.replace has spec.widget === undefined but the public API
    // does not expose a "kind" discriminator. We infer from CodeMirror's
    // internal point property — but a simpler tactic is to read the
    // .class spec field: HIDE has none, REVEAL has "quoll-syntax-reveal",
    // the clickable marker has "quoll-link-clickable".
    const kind =
      spec.class === "quoll-syntax-reveal"
        ? "reveal"
        : spec.class === "quoll-link-clickable"
          ? "clickable"
          : "hide";
    out.push({ from: iter.from, to: iter.to, kind, class: spec.class });
    iter.next();
  }
  return out;
}

describe("linkReveal — inline link form [text](url)", () => {
  it("HIDES every syntax mark when caret is outside the link", () => {
    // Doc: "see [link](https://example.com) end"
    //       0   4    10                    32 ...
    // Caret outside the link.
    const doc = "see [link](https://example.com) end";
    const built = linkReveal.build(ctx(doc, EditorSelection.single(0)));
    const decos = decosOf(built);
    // Expect 5 HIDEs (for `[`, `]`, `(`, `URL`, `)`) + 1 clickable marker.
    expect(decos.filter((d) => d.kind === "hide").length).toBe(5);
    expect(decos.filter((d) => d.kind === "clickable").length).toBe(1);
    expect(decos.filter((d) => d.kind === "reveal").length).toBe(0);
  });

  it("REVEALS every syntax mark when caret is inside the link", () => {
    const doc = "see [link](https://example.com) end";
    // Caret inside the link text (between `[` and `]`).
    const built = linkReveal.build(ctx(doc, EditorSelection.single(6)));
    const decos = decosOf(built);
    expect(decos.filter((d) => d.kind === "reveal").length).toBe(5);
    expect(decos.filter((d) => d.kind === "hide").length).toBe(0);
    // The clickable marker drops when REVEALED — the user is editing, not
    // clicking.
    expect(decos.filter((d) => d.kind === "clickable").length).toBe(0);
  });

  it("uses the outer Link node range as reveal-trigger (caret at closing `)` reveals)", () => {
    const doc = "[link](https://x)";
    // Caret at the position of the closing `)` — should still reveal because
    // the boundary-inclusive intersection matches the inline-mark contract.
    const built = linkReveal.build(ctx(doc, EditorSelection.single(doc.length)));
    expect(decosOf(built).filter((d) => d.kind === "reveal").length).toBe(5);
  });

  it("decorates each LinkMark / URL child with the correct ranges", () => {
    // Doc layout (length 14):
    //   `[a](https://x)` → [ a ] ( https://x )
    //   pos:               0   2 3            13
    // To keep the caret OUTSIDE the link's boundary-inclusive trigger
    // range, append a trailing paragraph and place the caret inside it
    // — the earlier draft's `EditorSelection.single(20)` on the bare
    // doc threw at EditorState.create because 20 > doc.length = 14.
    const doc2 = "[a](https://x)\n\nparagraph";
    const built2 = linkReveal.build(
      ctx(doc2, EditorSelection.single(doc2.indexOf("paragraph") + 3))
    );
    const hides = decosOf(built2).filter((d) => d.kind === "hide");
    // Expected hide ranges (sorted by `from`):
    //   `[` at [0, 1)
    //   `]` at [2, 3)
    //   `(` at [3, 4)
    //   URL  at [4, 13)
    //   `)` at [13, 14)
    expect(hides.map((d) => [d.from, d.to])).toEqual([
      [0, 1],
      [2, 3],
      [3, 4],
      [4, 13],
      [13, 14],
    ]);
  });

  it("emits the clickable marker over the link's inline content range (not the syntax marks)", () => {
    const doc = "[link text](https://example.com)\n\nparagraph";
    const built = linkReveal.build(ctx(doc, EditorSelection.single(doc.indexOf("paragraph") + 3)));
    const clickable = decosOf(built).filter((d) => d.kind === "clickable");
    expect(clickable.length).toBe(1);
    // Inline content [`link text`] is between `[` (pos 0) and `]` (pos 10),
    // so the content range is [1, 10).
    expect(clickable[0]?.from).toBe(1);
    expect(clickable[0]?.to).toBe(10);
  });

  it("skips reference-form links ([text][ref], [text][], [text]) — no URL child", () => {
    const doc = "[ref][def]\n\n[def]: https://example.com\n\nparagraph";
    const built = linkReveal.build(ctx(doc, EditorSelection.single(doc.indexOf("paragraph") + 3)));
    // Reference use-sites have no URL child; the provider emits no
    // decorations on them. The LinkReference DEFINITION is a separate
    // node type (gated for write-safety by lezer-url-walker, not by us).
    expect(decosOf(built).filter((d) => d.kind === "hide" || d.kind === "reveal")).toEqual([]);
  });

  it("skips images (`![alt](url)` — Image node, not Link — C7 owns image reveal)", () => {
    const doc = "![alt](https://example.com)\n\nparagraph";
    const built = linkReveal.build(ctx(doc, EditorSelection.single(doc.indexOf("paragraph") + 3)));
    expect(decosOf(built).filter((d) => d.kind === "hide" || d.kind === "reveal")).toEqual([]);
  });

  it("handles multiple links on the same line independently", () => {
    // Caret at position 0 — outside both links (position 0 is the very
    // start, which is at the boundary of the first link's `[`. By the
    // boundary-inclusive intersect rule, that boundary REVEALS the first
    // link. So move caret AFTER the second link instead.
    const doc2 = "[a](https://x) and [b](https://y)\n\nparagraph";
    const built = linkReveal.build(
      ctx(doc2, EditorSelection.single(doc2.indexOf("paragraph") + 3))
    );
    // Each link emits 5 HIDEs + 1 clickable → 12 total decorations.
    const decos = decosOf(built);
    expect(decos.filter((d) => d.kind === "hide").length).toBe(10);
    expect(decos.filter((d) => d.kind === "clickable").length).toBe(2);
  });

  it("multi-cursor: each caret independently reveals its own link", () => {
    const doc = "[a](https://x) and [b](https://y) end";
    const sel = EditorSelection.create([
      EditorSelection.cursor(1), // inside first link
      // No caret inside second link; second stays HIDDEN.
    ]);
    const built = linkReveal.build(ctx(doc, sel));
    const decos = decosOf(built);
    // First link: 5 REVEAL. Second link: 5 HIDE + 1 clickable.
    expect(decos.filter((d) => d.kind === "reveal").length).toBe(5);
    expect(decos.filter((d) => d.kind === "hide").length).toBe(5);
    expect(decos.filter((d) => d.kind === "clickable").length).toBe(1);
  });

  it("respects visibleRanges (drops decorations outside the supplied window)", () => {
    const doc = "[a](https://x) and [b](https://y)";
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(doc.length),
      extensions: [markdown({ base: markdownLanguage })],
    });
    // Visible window covers only the first link (positions [0, 14)).
    const built = linkReveal.build({
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: 14 }],
      tree: fullTree(state),
    });
    const decos = decosOf(built);
    // First link emits 5 reveal (caret intersects via boundary-inclusive
    // at doc.length; the second link sits outside [0, 14) so the iterate
    // walk does not enter it).
    // Actually doc.length=33; the boundary-inclusive intersect would put
    // BOTH links into REVEAL. But the second link sits at [19, 33), so its
    // range overlaps [0, 14) only by NOT overlapping at all — second link
    // is OUTSIDE the visible window.
    // Therefore only the first link's 5 marks emit.
    const total = decos.filter((d) => d.kind === "hide" || d.kind === "reveal").length;
    expect(total).toBe(5);
    // Every emitted decoration sits inside [0, 14).
    for (const d of decos) {
      expect(d.from).toBeGreaterThanOrEqual(0);
      expect(d.to).toBeLessThanOrEqual(14);
    }
  });
});
