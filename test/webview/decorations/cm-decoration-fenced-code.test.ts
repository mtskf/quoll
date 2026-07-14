import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  buildFencedCodePanel,
  FENCED_CODE_FENCE_HIDDEN_CLASS,
  FENCED_CODE_HAS_LANGUAGE_CLASS,
  FENCED_CODE_OPEN_CLASS,
  fencedCodeLineClasses,
} from "../../../src/webview/cm/decorations/block-style.js";
import { syntaxRevealProviders } from "../../../src/webview/cm/decorations/index.js";
import type { BuildContext } from "../../../src/webview/cm/decorations/types.js";
import { fencedCodeReveal } from "../../../src/webview/cm/fenced-code/fenced-code-reveal.js";
import { fullTree } from "../helpers/full-tree.js";

function ctx(
  doc: string,
  selection: EditorSelection,
  visibleRange?: { from: number; to: number }
): BuildContext {
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  return {
    state,
    selection: state.selection,
    visibleRanges: [visibleRange ?? { from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

type Tag = { from: number; to: number; kind: "mark" | "replace" };

function tagsOf(set: DecorationSet): Tag[] {
  const out: Tag[] = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const cls = (iter.value.spec as { class?: string }).class;
    out.push({ from: iter.from, to: iter.to, kind: cls === undefined ? "replace" : "mark" });
    iter.next();
  }
  return out;
}

/** Build EVERY registered reveal provider over the same ctx and flatten the
 *  emitted decorations — mirrors how the orchestrator merges providers, but at
 *  the registry level so the assertion does not name any single provider. */
function mergedTags(c: BuildContext): Tag[] {
  return syntaxRevealProviders.flatMap((p) => tagsOf(p.build(c)));
}

function covers(tags: Tag[], from: number, to: number, kind: Tag["kind"]): boolean {
  return tags.some((t) => t.kind === kind && t.from <= from && t.to >= to);
}

// Reproduce-first (registry level): with the caret OUTSIDE a fenced code block,
// SOME registered provider must conceal the opening AND closing ``` fence marks
// with a `replace` decoration — exactly as heading/blockquote conceal their
// markers. Before fencedCodeReveal exists no provider touches FencedCode's
// CodeMark children, so this is RED against the current registry.
describe("reproduce: registry conceals fenced code fences", () => {
  it("hides the opening AND closing ``` when the caret is elsewhere", () => {
    const doc = "text\n\n```js\nconst x = 1;\n```\n\nafter";
    const openFrom = doc.indexOf("```"); // opening fence ```
    const closeFrom = doc.lastIndexOf("```"); // closing fence ```
    const caret = doc.indexOf("after") + 2; // outside the block
    const tags = mergedTags(ctx(doc, EditorSelection.single(caret)));
    expect(covers(tags, openFrom, openFrom + 3, "replace")).toBe(true);
    expect(covers(tags, closeFrom, closeFrom + 3, "replace")).toBe(true);
  });

  it("also conceals the fence of a block WITHOUT a language tag", () => {
    const doc = "text\n\n```\nplain\n```\n\nafter";
    const openFrom = doc.indexOf("```");
    const closeFrom = doc.lastIndexOf("```");
    const caret = doc.indexOf("after") + 2;
    const tags = mergedTags(ctx(doc, EditorSelection.single(caret)));
    expect(covers(tags, openFrom, openFrom + 3, "replace")).toBe(true);
    expect(covers(tags, closeFrom, closeFrom + 3, "replace")).toBe(true);
  });
});

describe("fenced code reveal provider", () => {
  it("HIDE: opening fence replace covers `\\`\\`\\`lang` (mark + language tag) when caret is outside", () => {
    const doc = "```js\nconst x = 1;\n```\n\npara";
    const openLineEnd = doc.indexOf("\n"); // end of "```js"
    const caret = doc.indexOf("para") + 2;
    const set = fencedCodeReveal.build(ctx(doc, EditorSelection.single(caret)));
    const tags = tagsOf(set);
    const open = tags.find((t) => t.from === 0);
    expect(open).toEqual({ from: 0, to: openLineEnd, kind: "replace" }); // [0,5): ```js
  });

  it("HIDE: closing fence replace covers `\\`\\`\\``", () => {
    const doc = "```js\nconst x = 1;\n```\n\npara";
    const closeFrom = doc.lastIndexOf("```");
    const caret = doc.indexOf("para") + 2;
    const tags = tagsOf(fencedCodeReveal.build(ctx(doc, EditorSelection.single(caret))));
    const close = tags.find((t) => t.from === closeFrom);
    expect(close).toEqual({ from: closeFrom, to: closeFrom + 3, kind: "replace" });
  });

  it("REVEAL: caret on the opening fence line reveals BOTH fences (block-scoped)", () => {
    const doc = "```js\nconst x = 1;\n```\n\npara";
    const closeFrom = doc.lastIndexOf("```");
    const set = fencedCodeReveal.build(ctx(doc, EditorSelection.single(2))); // inside "```js"
    const tags = tagsOf(set);
    // Opening fence: mark over the ``` only, NOT the `js` tag.
    expect(tags).toContainEqual({ from: 0, to: 3, kind: "mark" });
    // Closing fence ALSO revealed now (caret is inside the block).
    expect(tags).toContainEqual({ from: closeFrom, to: closeFrom + 3, kind: "mark" });
  });

  it("REVEAL: caret on the closing fence line reveals BOTH fences (block-scoped)", () => {
    const doc = "```js\nconst x = 1;\n```\n\npara";
    const closeFrom = doc.lastIndexOf("```");
    const set = fencedCodeReveal.build(ctx(doc, EditorSelection.single(closeFrom + 1)));
    const tags = tagsOf(set);
    expect(tags).toContainEqual({ from: closeFrom, to: closeFrom + 3, kind: "mark" });
    // Opening fence ALSO revealed now.
    expect(tags).toContainEqual({ from: 0, to: 3, kind: "mark" });
  });

  it("BLOCK-SCOPED: caret in the CODE BODY reveals BOTH fences", () => {
    const doc = "```js\nconst x = 1;\n```\n\npara";
    const closeFrom = doc.lastIndexOf("```");
    const caret = doc.indexOf("const") + 2; // inside the code body
    const tags = tagsOf(fencedCodeReveal.build(ctx(doc, EditorSelection.single(caret))));
    // Both fences dim to a REVEAL mark over the ``` only (language tag shows normally).
    // Exact match (not toContainEqual) also pins the TOTAL count — a spurious extra
    // decoration on a body caret would fail here (builder emits sorted by `from`).
    expect(tags).toEqual([
      { from: 0, to: 3, kind: "mark" },
      { from: closeFrom, to: closeFrom + 3, kind: "mark" },
    ]);
  });

  it("hides a block WITHOUT a language tag (opening replace is the bare ```)", () => {
    const doc = "```\nplain\n```\n\npara";
    const caret = doc.indexOf("para") + 2;
    const tags = tagsOf(fencedCodeReveal.build(ctx(doc, EditorSelection.single(caret))));
    // No CodeInfo, so the opening fence line IS just ``` → replace [0,3).
    expect(tags[0]).toEqual({ from: 0, to: 3, kind: "replace" });
  });

  it("unclosed block at EOF: caret inside reveals the single opening fence", () => {
    const doc = "```js\nconst x = 1;"; // no closing ```
    const tags = tagsOf(fencedCodeReveal.build(ctx(doc, EditorSelection.single(doc.length))));
    expect(tags).toEqual([{ from: 0, to: 3, kind: "mark" }]);
  });

  it("unclosed block at EOF: caret in preceding prose hides the single opening fence", () => {
    const doc = "intro\n\n```js\nconst x = 1;";
    const openFrom = doc.indexOf("```");
    const openLineEnd = doc.indexOf("\n", openFrom); // end of "```js" (its own line), not intro's newline
    const tags = tagsOf(fencedCodeReveal.build(ctx(doc, EditorSelection.single(2))));
    expect(tags).toEqual([{ from: openFrom, to: openLineEnd, kind: "replace" }]);
  });

  it("does NOT touch InlineCode's CodeMark (inline `code` is inline-mark-reveal's concern)", () => {
    const doc = "a `code` b";
    const set = fencedCodeReveal.build(ctx(doc, EditorSelection.single(0)));
    expect(set.size).toBe(0);
  });

  it("blockquote-nested fence: REVEAL starts at the ``` so it tiles with the `> ` reveal (no overlap)", () => {
    const doc = "> ```\n> code\n> ```";
    // Caret in the body → block-scoped reveal dims BOTH fences.
    const tags = tagsOf(
      fencedCodeReveal.build(ctx(doc, EditorSelection.single(doc.indexOf("code") + 1)))
    );
    const openMark = doc.indexOf("```"); // 2, after "> "
    const closeMark = doc.lastIndexOf("```"); // 15, after "> "
    // The reveal marks begin at the ``` (offset 2 / 15), NOT the line start (0),
    // leaving the leading `> ` to blockquote-reveal.
    expect(tags).toContainEqual({ from: openMark, to: openMark + 3, kind: "mark" });
    expect(tags).toContainEqual({ from: closeMark, to: closeMark + 3, kind: "mark" });
    // Critically: no decoration starts at the blockquote line start.
    expect(tags.some((t) => t.from === 0)).toBe(false);
  });

  it("respects visibleRanges: a fence mark outside the window is NOT emitted", () => {
    const doc = "```js\nconst x = 1;\n```\n\npara";
    const closeFrom = doc.lastIndexOf("```");
    // Window covers only the opening fence + body, ending before the close.
    const set = fencedCodeReveal.build(
      ctx(doc, EditorSelection.single(doc.indexOf("para") + 2), { from: 0, to: closeFrom - 1 })
    );
    const tags = tagsOf(set);
    expect(tags.some((t) => t.from === closeFrom)).toBe(false);
    expect(tags.some((t) => t.from === 0)).toBe(true); // opening still emitted
  });

  it("identity round-trip: ctx.state.doc is never mutated", () => {
    const doc = "```js\nconst x = 1;\n```";
    const c = ctx(doc, EditorSelection.single(0));
    const before = c.state.doc.toString();
    fencedCodeReveal.build(c);
    expect(c.state.doc.toString()).toBe(before);
  });
});

// Header-bar gate: the has-language class rides the visible open edge only when the
// fence is writable AND carries a non-empty plain language token. Two layers: the
// pure fencedCodeLineClasses fold-in (deterministic, no view) + the real builder's
// hasLanguage computation (buildFencedCodePanel over a BuildContext, incl. the
// read-only gate — no DOM, mirrors the reveal-provider idiom above).
const baseLandmarks = {
  openFenceLine: 1,
  closeFenceLine: 3,
  firstBodyLine: 2,
  lastBodyLine: 2,
  openConcealed: false,
  closeConcealed: false,
  outerOpen: false,
  outerClose: false,
};

describe("fencedCodeLineClasses has-language fold-in", () => {
  it("adds has-language to the revealed open fence line when hasLanguage", () => {
    const cls = fencedCodeLineClasses(1, { ...baseLandmarks, hasLanguage: true });
    expect(cls).toContain(FENCED_CODE_OPEN_CLASS);
    expect(cls).toContain(FENCED_CODE_HAS_LANGUAGE_CLASS);
  });

  it("omits has-language when hasLanguage is false", () => {
    const cls = fencedCodeLineClasses(1, { ...baseLandmarks, hasLanguage: false });
    expect(cls).toContain(FENCED_CODE_OPEN_CLASS);
    expect(cls).not.toContain(FENCED_CODE_HAS_LANGUAGE_CLASS);
  });

  it("migrates has-language onto the first body line when the open fence is concealed", () => {
    const L = { ...baseLandmarks, openConcealed: true, hasLanguage: true };
    // The concealed fence row collapses to the hidden class ONLY — no has-language.
    expect(fencedCodeLineClasses(1, L)).toEqual([FENCED_CODE_FENCE_HIDDEN_CLASS]);
    // The first body line carries the migrated open edge + has-language.
    const body = fencedCodeLineClasses(2, L);
    expect(body).toContain(FENCED_CODE_OPEN_CLASS);
    expect(body).toContain(FENCED_CODE_HAS_LANGUAGE_CLASS);
  });
});

describe("buildFencedCodePanel has-language builder gate", () => {
  // line.from → class list of the emitted Decoration.line for that line.
  function panelClasses(doc: string, caret: number, readOnly = false): Map<number, string[]> {
    const state = EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [
        markdown({ base: markdownLanguage }),
        EditorState.allowMultipleSelections.of(true),
        EditorState.readOnly.of(readOnly),
      ],
    });
    const c: BuildContext = {
      state,
      selection: state.selection,
      visibleRanges: [{ from: 0, to: state.doc.length }],
      tree: fullTree(state),
    };
    const out = new Map<number, string[]>();
    const iter = buildFencedCodePanel(c).iter();
    while (iter.value !== null) {
      const cls = (iter.value.spec as { class?: string }).class ?? "";
      out.set(iter.from, cls.split(" ").filter(Boolean));
      iter.next();
    }
    return out;
  }

  it("tags a language-tagged writable block's revealed open line", () => {
    // Caret on the open fence line → revealed → the open line (from 0) is the edge.
    const open = panelClasses("```js\nx\n```\n", 2).get(0) ?? [];
    expect(open).toContain(FENCED_CODE_OPEN_CLASS);
    expect(open).toContain(FENCED_CODE_HAS_LANGUAGE_CLASS);
  });

  it("migrates the tag to the first body line when the block is concealed (caret off)", () => {
    const doc = "```js\nx\n```\n\npara";
    const classes = panelClasses(doc, doc.indexOf("para") + 1);
    // Concealed fence row (line.from 0) is hidden-only; the first body line (from 6)
    // carries the migrated has-language edge.
    expect(classes.get(0)).toEqual([FENCED_CODE_FENCE_HIDDEN_CLASS]);
    expect(classes.get(6) ?? []).toContain(FENCED_CODE_HAS_LANGUAGE_CLASS);
  });

  it("does NOT tag a bare (language-less) block", () => {
    const open = panelClasses("```\nx\n```\n", 2).get(0) ?? [];
    expect(open).toContain(FENCED_CODE_OPEN_CLASS);
    expect(open).not.toContain(FENCED_CODE_HAS_LANGUAGE_CLASS);
  });

  it("does NOT tag an attr-list fence (non-plain info string)", () => {
    const open = panelClasses("```{.js #id}\nx\n```\n", 2).get(0) ?? [];
    expect(open).not.toContain(FENCED_CODE_HAS_LANGUAGE_CLASS);
  });

  it("does NOT tag a language-tagged block on a READ-ONLY surface", () => {
    const open = panelClasses("```js\nx\n```\n", 2, true).get(0) ?? [];
    expect(open).toContain(FENCED_CODE_OPEN_CLASS);
    expect(open).not.toContain(FENCED_CODE_HAS_LANGUAGE_CLASS);
  });
});
