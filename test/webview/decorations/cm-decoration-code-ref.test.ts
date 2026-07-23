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
  it("exposes the reference to assistive tech as a link (role + hover title)", () => {
    // The interior text ("src/foo.ts:42") is the accessible name; role=link tells
    // AT the span is actionable. Keeps SR discoverability in lockstep with the
    // keyboard-open command (code-ref-handlers.ts).
    const set = codeRefReveal.build(ctxFor("see `src/foo.ts:42` now"));
    const cursor = set.iter();
    expect(cursor.value?.spec.attributes).toMatchObject({ role: "link" });
  });
});
