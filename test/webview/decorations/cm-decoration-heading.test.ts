import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { headingReveal } from "../../../src/webview/cm/decorations/heading-reveal.js";
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

function spec(
  set: DecorationSet
): Array<{ from: number; to: number; kind: "mark" | "replace"; cls?: string }> {
  const out: Array<{
    from: number;
    to: number;
    kind: "mark" | "replace";
    cls?: string;
  }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const cls = (iter.value.spec as { class?: string }).class;
    out.push({
      from: iter.from,
      to: iter.to,
      kind: cls === undefined ? "replace" : "mark",
      cls,
    });
    iter.next();
  }
  return out;
}

describe("heading reveal provider", () => {
  it("HIDE: replace range covers `# ` (mark + trailing space) when no selection on the line", () => {
    // doc layout: "# Heading\nparagraph"
    // HeaderMark = [0, 1) (the `#`).
    // HIDE range MUST extend to absorb the trailing space, so the replace
    // covers [0, 2). Without absorbing the space the heading would render
    // as " Heading" (one-char phantom indent).
    const doc = "# Heading\nparagraph";
    const set = headingReveal.build(ctx(doc, EditorSelection.single(15))); // caret in "paragraph"
    const ranges = spec(set);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.kind).toBe("replace");
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(2); // `#` + trailing space
  });

  it("REVEAL: mark range covers only the `#` (NOT the trailing space) when caret on the line", () => {
    const doc = "# Heading\nparagraph";
    const set = headingReveal.build(ctx(doc, EditorSelection.single(5))); // caret on "Heading"
    const ranges = spec(set);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.kind).toBe("mark");
    expect(ranges[0]?.cls).toBe("quoll-syntax-reveal");
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(1); // mark-exact range — the space is naturally visible
  });

  it("handles all six ATX levels; HIDE widths = mark + 1 trailing space", () => {
    // A trailing non-heading paragraph + cursor INSIDE it, so no heading
    // line is selected (boundary-inclusive selection means
    // `single(doc.length)` would have sat on the last heading line).
    const doc = "# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3; // well inside "paragraph"
    const set = headingReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = spec(set);
    expect(ranges.length).toBe(6);
    expect(ranges.every((r) => r.kind === "replace")).toBe(true);
    const widths = ranges.map((r) => r.to - r.from).sort((a, b) => a - b);
    expect(widths).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("ATX closing `#` (`# heading #`) is NOT decorated — only the leading mark", () => {
    // Lezer emits the trailing `#` of `# heading #` as a HeaderMark too, but
    // per the user-prompt UX only the LEADING `#` group is the reveal target.
    // Assert exactly ONE decoration (over the leading `[0, 2)` = `# `).
    const doc = "# heading #\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = headingReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = spec(set);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(2); // leading `#` + trailing space
    expect(ranges[0]?.kind).toBe("replace");
  });

  it("HIDE: absorbs MULTIPLE structural spaces (`#  Heading` — valid CommonMark)", () => {
    // Previously the helper consumed only ONE space; `#  Heading` (double
    // space) left a phantom indent in the rendered output. The fix consumes
    // ALL consecutive spaces/tabs between the mark and the content.
    const doc = "#  Heading\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = headingReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = spec(set);
    expect(ranges.length).toBe(1);
    expect(ranges[0]?.kind).toBe("replace");
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(3); // `#` + 2 spaces
  });

  it("HIDE: no trailing space → replace covers only the mark (e.g. `#` followed by EOL)", () => {
    // Same boundary-inclusive avoidance — caret in the trailing paragraph,
    // not at doc.length (which would have sat on a heading line).
    const doc = "#\n# also\n\nparagraph";
    const caret = doc.indexOf("paragraph") + 3;
    const set = headingReveal.build(ctx(doc, EditorSelection.single(caret)));
    const ranges = spec(set);
    expect(ranges.length).toBe(2);
    // First heading "#" at offset 0, no trailing space → HIDE = [0, 1).
    expect(ranges[0]?.from).toBe(0);
    expect(ranges[0]?.to).toBe(1);
  });

  it("reveal triggers per-caret in a multi-cursor selection (each line independently)", () => {
    const doc = "# a\n# b\n# c";
    // Cursors on lines 1 and 3, NOT on line 2.
    const sel = EditorSelection.create([
      EditorSelection.cursor(2), // inside "# a"
      EditorSelection.cursor(10), // inside "# c"
    ]);
    const set = headingReveal.build(ctx(doc, sel));
    const ranges = spec(set);
    expect(ranges.length).toBe(3);
    expect(ranges[0]?.kind).toBe("mark"); // # a — revealed
    expect(ranges[1]?.kind).toBe("replace"); // # b — hidden
    expect(ranges[2]?.kind).toBe("mark"); // # c — revealed
  });

  it("emits nothing for a paragraph (no heading construct)", () => {
    const doc = "just a paragraph\nanother line";
    const set = headingReveal.build(ctx(doc, EditorSelection.single(0)));
    expect(set.size).toBe(0);
  });

  it("Setext headings (==== / ---- underlines) are NOT in scope — provider does not emit", () => {
    const doc = "Setext\n======\nbody";
    const set = headingReveal.build(ctx(doc, EditorSelection.single(0)));
    expect(set.size).toBe(0);
  });

  it("does not emit decorations outside visibleRanges", () => {
    const doc = "# top\n\n# middle\n\n# bottom";
    const set = headingReveal.build(ctx(doc, EditorSelection.single(0), { from: 0, to: 5 }));
    expect(set.size).toBe(1); // only the first `#`
    const iter = set.iter();
    expect(iter.from).toBe(0);
  });

  it("identity round-trip: ctx.state.doc is never mutated by build()", () => {
    const doc = "# Heading\nparagraph";
    const c = ctx(doc, EditorSelection.single(5));
    const before = c.state.doc.toString();
    headingReveal.build(c);
    expect(c.state.doc.toString()).toBe(before);
  });
});
