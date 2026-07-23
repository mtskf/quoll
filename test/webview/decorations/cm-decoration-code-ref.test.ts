import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { codeRefReveal } from "../../../src/webview/cm/code-ref/code-ref-reveal.js";
import type { BuildContext } from "../../../src/webview/cm/decorations/types.js";
import { fullTree } from "../helpers/full-tree.js";

function ctxFor(doc: string): BuildContext {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  return {
    state,
    selection: state.selection,
    visibleRanges: [{ from: 0, to: doc.length }],
    tree: fullTree(state),
  };
}
function ctxWithSelection(doc: string, anchor: number, head: number): BuildContext {
  const state = EditorState.create({
    doc,
    selection: { anchor, head },
    extensions: [markdown()],
  });
  return {
    state,
    selection: state.selection,
    visibleRanges: [{ from: 0, to: doc.length }],
    tree: fullTree(state),
  };
}
function marks(doc: string): Array<{ from: number; to: number }> {
  const set = codeRefReveal.build(ctxFor(doc));
  const out: Array<{ from: number; to: number }> = [];
  const cursor = set.iter();
  while (cursor.value !== null) {
    out.push({ from: cursor.from, to: cursor.to });
    cursor.next();
  }
  return out;
}

describe("codeRefReveal", () => {
  it("marks the interior of a path-shaped inline code span", () => {
    const doc = "see `src/foo.ts:42` now";
    const [m] = marks(doc);
    expect(doc.slice(m.from, m.to)).toBe("src/foo.ts:42");
  });
  it("does not mark a non-path or .md inline code span", () => {
    expect(marks("call `useState` here")).toEqual([]);
    expect(marks("open `docs/notes.md` please")).toEqual([]);
  });
  it("does not mark inline code inside a link (the link owns the click)", () => {
    expect(marks("[`src/foo.ts`](other.md)")).toEqual([]);
  });
  it("does not mark plain prose", () => {
    expect(marks("just some src/foo.ts text")).toEqual([]);
  });
  it("exposes the reference to assistive tech as a link (role + keyshortcuts + title)", () => {
    // The interior text ("src/foo.ts:42") is the accessible name; role=link tells
    // AT the span is actionable, and aria-keyshortcuts/title announce the activation
    // gesture (the actual Mod-Enter gesture, since there is no plain-Enter link
    // activation here).
    const set = codeRefReveal.build(ctxFor("see `src/foo.ts:42` now"));
    const cursor = set.iter();
    expect(cursor.value?.spec.attributes).toEqual({
      role: "link",
      title: "Open referenced file (Cmd/Ctrl+Enter)",
      "aria-keyshortcuts": "Meta+Enter Control+Enter",
    });
  });
  it("keeps the affordance when a bare caret is inside the reference (Mod-Enter position)", () => {
    // The affordance is selection-independent: it must survive a caret inside the
    // reference, since that is exactly where the Mod-Enter command is invoked —
    // suppressing there would make the role=link cue and the command mutually
    // exclusive.
    const doc = "see `src/foo.ts:42` now";
    const caret = doc.indexOf("foo");
    const set = codeRefReveal.build(ctxWithSelection(doc, caret, caret));
    expect(set.iter().value?.spec.attributes).toMatchObject({ role: "link" });
  });
  it("keeps the affordance during a non-empty selection over the reference (selection-independent)", () => {
    // Unlike the syntax-reveal providers, this mark is purely additive (the
    // inline-code text always renders as-is), so it is never suppressed by
    // selection — the underline + role/name stay put even while text is selected.
    const doc = "see `src/foo.ts:42` now";
    const set = codeRefReveal.build(ctxWithSelection(doc, doc.indexOf("src"), doc.indexOf(":42")));
    expect(set.iter().value?.spec.attributes).toMatchObject({ role: "link" });
  });
});
