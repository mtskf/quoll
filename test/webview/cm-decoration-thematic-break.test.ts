// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { type DecorationSet, EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { thematicBreakReveal } from "../../src/webview/cm/decorations/thematic-break-reveal.js";
import { ThematicBreakWidget } from "../../src/webview/cm/decorations/thematic-break-widget.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import { frontmatterBlockField } from "../../src/webview/cm/frontmatter/frontmatter-field.js";
import { fullTree } from "./helpers/full-tree.js";

vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage: vi.fn() }),
  subscribeToHost: () => () => {},
}));

describe("ThematicBreakWidget", () => {
  it("renders a separator span with the quoll-thematic-break class", () => {
    const dom = new ThematicBreakWidget().toDOM();
    expect(dom.tagName).toBe("SPAN");
    expect(dom.classList.contains("quoll-thematic-break")).toBe(true);
    expect(dom.getAttribute("role")).toBe("separator");
  });

  it("instances with the same indent are eq (CM can reuse DOM)", () => {
    expect(new ThematicBreakWidget().eq(new ThematicBreakWidget())).toBe(true);
    expect(new ThematicBreakWidget(2).eq(new ThematicBreakWidget(2))).toBe(true);
  });

  it("instances with a DIFFERENT indent are NOT eq (force a DOM rebuild)", () => {
    expect(new ThematicBreakWidget(0).eq(new ThematicBreakWidget(2))).toBe(false);
    expect(new ThematicBreakWidget(2).eq(new ThematicBreakWidget(4))).toBe(false);
  });

  it("insets the rule by one prose-space per indent column when indentCols > 0", () => {
    // A list-child break carries its source-indent column count; the widget
    // insets the hairline (background-clip:content-box, styles.css) to the
    // item's content column via padding-inline-start.
    const dom = new ThematicBreakWidget(2).toDOM();
    expect(dom.style.paddingInlineStart).toBe("calc(2 * var(--quoll-prose-space, 1ch))");
  });

  it("does NOT set padding for a top-level break (indentCols 0 — byte-identical)", () => {
    expect(new ThematicBreakWidget().toDOM().style.paddingInlineStart).toBe("");
    expect(new ThematicBreakWidget(0).toDOM().style.paddingInlineStart).toBe("");
  });

  it("does NOT ignore events — clicks fall through to CM so click-to-reveal works", () => {
    // The rule is display-only but NOT atomic; returning false lets a click on
    // the rendered rule place the caret on the HR line (→ reveal). Returning true
    // would make CM ignore the click (eventBelongsToEditor short-circuits).
    expect(new ThematicBreakWidget().ignoreEvent()).toBe(false);
  });
});

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

function spec(set: DecorationSet): Array<{
  from: number;
  to: number;
  kind: "mark" | "replace";
  cls?: string;
  hasWidget: boolean;
  indentCols?: number;
}> {
  const out: Array<{
    from: number;
    to: number;
    kind: "mark" | "replace";
    cls?: string;
    hasWidget: boolean;
    indentCols?: number;
  }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const s = iter.value.spec as { class?: string; widget?: unknown };
    out.push({
      from: iter.from,
      to: iter.to,
      kind: s.class === undefined ? "replace" : "mark",
      cls: s.class,
      hasWidget: s.widget !== undefined,
      indentCols: s.widget instanceof ThematicBreakWidget ? s.widget.indentCols : undefined,
    });
    iter.next();
  }
  return out;
}

describe("thematic break reveal provider", () => {
  it("HIDE: replace-widget over the WHOLE line when no selection on the HR line", () => {
    const doc = "a\n\n---\n\nb"; // HorizontalRule [3,6]; its line is [3,6]
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(8))); // caret on "b"
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("replace");
    expect(r[0]?.hasWidget).toBe(true);
    expect(r[0]?.from).toBe(3);
    expect(r[0]?.to).toBe(6);
  });

  it("HIDE: replace covers the whole line INCLUDING leading indent (`   ---`)", () => {
    const doc = "text\n\n   ---\n\nb"; // line [6,12], HorizontalRule [9,12]
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(14))); // caret on "b"
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("replace");
    expect(r[0]?.from).toBe(6); // line.from — indent absorbed
    expect(r[0]?.to).toBe(12);
    expect(r[0]?.indentCols).toBe(0); // top-level indent → flush-left, no inset
  });

  it("HIDE: a list-item child break insets to the item's content column (`- x\\n\\n  ---`)", () => {
    // `- item\n\n  ---\n\nb`: BulletList > ListItem > HorizontalRule [10,13]; the
    // HR line `  ---` is [8,13]. The 2-space gap is LIST-CONTINUATION indent, not
    // a top-level indent — so the replace still starts at line.from (widget owns
    // the whole line, no stray whitespace) but the widget carries indentCols=2 so
    // its hairline insets to the item's content column (matching the sibling
    // nested paragraph). Distinguishing this from a top-level `   ---` needs the
    // enclosing ListItem node context, not the gap's characters.
    const doc = "- item\n\n  ---\n\nb";
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(15))); // caret on "b"
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("replace");
    expect(r[0]?.from).toBe(8); // line.from — whole line replaced
    expect(r[0]?.to).toBe(13);
    expect(r[0]?.indentCols).toBe(2); // inset by the 2-column source indent
  });

  it("HIDE: an ordered-list child break insets by its source-indent columns", () => {
    // `1. item\n\n   ---\n\nb`: OrderedList > ListItem > HorizontalRule; the HR
    // line `   ---` is [9,15], node [12,15]. The 3-space continuation indent →
    // indentCols=3.
    const doc = "1. item\n\n   ---\n\nb";
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(16)));
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("replace");
    expect(r[0]?.from).toBe(9);
    expect(r[0]?.indentCols).toBe(3);
  });

  it("REVEAL: dim mark over the node glyphs when caret is on the HR line", () => {
    const doc = "a\n\n---\n\nb";
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(4))); // caret in "---"
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("mark");
    expect(r[0]?.cls).toBe("quoll-syntax-reveal");
    expect(r[0]?.from).toBe(3);
    expect(r[0]?.to).toBe(6);
  });

  it("recognises `***` and `___` and `- - -` as thematic breaks", () => {
    for (const bar of ["***", "___", "- - -"]) {
      const doc = `a\n\n${bar}\n\nb`;
      const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(0)));
      const r = spec(set);
      expect(r.length).toBe(1);
      expect(r[0]?.kind).toBe("replace");
      expect(r[0]?.hasWidget).toBe(true);
    }
  });

  it("does NOT emit for a setext heading underline (`Heading\\n---`)", () => {
    const doc = "Heading\n---\nbody";
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(13))); // caret on "body"
    expect(set.size).toBe(0);
  });

  it("does NOT emit for a setext `===` underline", () => {
    const doc = "Heading\n===\nbody";
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(13)));
    expect(set.size).toBe(0);
  });

  it("emits nothing for a plain paragraph", () => {
    const doc = "just text\nmore text";
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(0)));
    expect(set.size).toBe(0);
  });

  it("per-caret reveal across multiple rules", () => {
    // Three HRs; caret only on the middle one.
    const doc = "a\n\n---\n\nb\n\n---\n\nc\n\n---\n\nd";
    // HR node/line spans: HR1 [3,6]; HR2 [11,14]; HR3 [19,22].
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(11))); // at HR2 line.from
    const r = spec(set);
    expect(r.length).toBe(3);
    expect(r[0]?.kind).toBe("replace"); // HR1 hidden
    expect(r[1]?.kind).toBe("mark"); // HR2 revealed
    expect(r[2]?.kind).toBe("replace"); // HR3 hidden
  });

  it("does not emit decorations outside visibleRanges", () => {
    const doc = "a\n\n---\n\nb\n\n---\n\nc";
    // Window only covers the first HR region.
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(8), { from: 0, to: 6 }));
    expect(set.size).toBe(1);
    expect(set.iter().from).toBe(3);
  });

  it("REVEAL branch: no mark emitted outside the window when an indented HR straddles the edge", () => {
    // "   ---\nnext": line [0,6], HorizontalRule node [3,6] (starts AFTER the
    // 3-space indent). tree.iterate({0,3}) still visits the node (Lezer touch
    // semantics) and the line overlaps [0,3], so with the caret ON the line the
    // reveal branch WOULD add a mark at the node span [3,6] — entirely outside
    // the window — unless the node range is guarded against the window.
    const doc = "   ---\nnext";
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(1), { from: 0, to: 3 }));
    expect(set.size).toBe(0);
  });

  it("HIDE: preserves a blockquote container prefix (`> ---`) — replace starts after `> `", () => {
    // `> ---` parses as Blockquote > QuoteMark [3,4] + HorizontalRule [5,8]; the
    // node covers only `---`, but the line is the whole `> ---`. Replacing the
    // whole line would swallow the `> ` quote marker and drop the rule out of
    // its blockquote — so the replace must start at the node (prefix preserved).
    const doc = "a\n\n> ---\n\nb"; // QuoteMark [3,4], HorizontalRule [5,8]
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(10))); // caret on "b"
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("replace");
    expect(r[0]?.hasWidget).toBe(true);
    expect(r[0]?.from).toBe(5); // node.from — the `> ` container prefix is kept
    expect(r[0]?.to).toBe(8);
    expect(r[0]?.indentCols).toBe(0); // container prefix ≠ list indent → no inset
  });

  it("HIDE: `- ---` is a real thematic break (dashes+spaces), NOT a list — whole line replaced", () => {
    // `- ---` parses as a single top-level HorizontalRule [3,8]: the leading `-`
    // is a rule glyph, not a bullet, so there is NO container prefix to preserve
    // and the whole line is correctly concealed behind the rule widget.
    const doc = "a\n\n- ---\n\nb"; // HorizontalRule [3,8], line [3,8]
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(10))); // caret on "b"
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("replace");
    expect(r[0]?.from).toBe(3); // whole `- ---` concealed
    expect(r[0]?.to).toBe(8);
    expect(r[0]?.indentCols).toBe(0); // a top-level HR, not a list item → no inset
  });

  it("REVEAL: `> ---` dims only the `---` glyphs, never the `> ` prefix", () => {
    const doc = "a\n\n> ---\n\nb";
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(6))); // caret in "---"
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.kind).toBe("mark");
    expect(r[0]?.from).toBe(5);
    expect(r[0]?.to).toBe(8);
  });

  it("identity round-trip: build() never mutates ctx.state.doc", () => {
    const doc = "a\n\n---\n\nb";
    const c = ctx(doc, EditorSelection.single(8));
    const before = c.state.doc.toString();
    thematicBreakReveal.build(c);
    expect(c.state.doc.toString()).toBe(before);
  });
});

function mountWithFrontmatter(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(doc.length), // caret at very end, off every HR line
    extensions: [markdown({ base: markdownLanguage }), quollSyntaxReveal(), frontmatterBlockField],
  });
  return new EditorView({ state, parent });
}

describe("thematic break — orchestrator integration", () => {
  it("registered in syntaxRevealProviders (length 8, includes thematicBreakReveal)", async () => {
    const { syntaxRevealProviders } = await import("../../src/webview/cm/decorations/index.js");
    expect(syntaxRevealProviders).toHaveLength(8);
    expect(syntaxRevealProviders).toContain(thematicBreakReveal);
  });

  it("renders a real thematic break as a rule widget (caret off the line)", () => {
    const view = mountWithFrontmatter("intro\n\n***\n\noutro");
    try {
      const rules = view.dom.querySelectorAll(".quoll-thematic-break");
      expect(rules.length).toBe(1);
      expect(rules[0]?.getAttribute("role")).toBe("separator");
      // Bytes untouched.
      expect(view.state.sliceDoc()).toBe("intro\n\n***\n\noutro");
    } finally {
      view.destroy();
    }
  });

  it("does NOT render the frontmatter opener `---` as a rule (exclusion zone)", () => {
    // Opener parses as HorizontalRule [0,3] but the frontmatter span is an
    // exclusion zone → arbitrate drops the opener decoration. The real HR
    // below the frontmatter DOES render.
    const view = mountWithFrontmatter("---\ntitle: x\n---\n\nbody\n\n---\n\nmore");
    try {
      const rules = view.dom.querySelectorAll(".quoll-thematic-break");
      expect(rules.length).toBe(1); // only the real HR, NOT the frontmatter opener
      // Frontmatter source bytes intact.
      expect(view.state.sliceDoc().startsWith("---\ntitle: x\n---")).toBe(true);
    } finally {
      view.destroy();
    }
  });
});
