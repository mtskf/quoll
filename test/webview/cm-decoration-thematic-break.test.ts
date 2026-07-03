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
  getHost: () => ({ postMessage: vi.fn(), setMetadata: vi.fn() }),
  subscribeToHost: () => () => {},
}));

describe("ThematicBreakWidget", () => {
  it("renders a separator span with the quoll-thematic-break class", () => {
    const dom = new ThematicBreakWidget().toDOM();
    expect(dom.tagName).toBe("SPAN");
    expect(dom.classList.contains("quoll-thematic-break")).toBe(true);
    expect(dom.getAttribute("role")).toBe("separator");
  });

  it("all instances are eq (stateless widget — CM can reuse DOM)", () => {
    expect(new ThematicBreakWidget().eq(new ThematicBreakWidget())).toBe(true);
  });

  it("ignores events (non-interactive, display-only)", () => {
    expect(new ThematicBreakWidget().ignoreEvent()).toBe(true);
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

function spec(
  set: DecorationSet
): Array<{ from: number; to: number; kind: "mark" | "replace"; cls?: string; hasWidget: boolean }> {
  const out: Array<{
    from: number;
    to: number;
    kind: "mark" | "replace";
    cls?: string;
    hasWidget: boolean;
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
    // Offsets: HR1 [3,6] line[3,6]; HR2 [10,13]; HR3 [17,20].
    const set = thematicBreakReveal.build(ctx(doc, EditorSelection.single(11))); // inside HR2
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
