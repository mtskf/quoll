import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { fencedCodeReveal } from "../../src/webview/cm/decorations/fenced-code-reveal.js";
import { syntaxRevealProviders } from "../../src/webview/cm/decorations/index.js";
import type { BuildContext } from "../../src/webview/cm/decorations/types.js";
import { fullTree } from "./helpers/full-tree.js";

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
