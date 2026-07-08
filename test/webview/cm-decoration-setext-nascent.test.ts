// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  SETEXT_NASCENT_CLASS,
  setextNascentReveal,
} from "../../src/webview/cm/decorations/setext-nascent-reveal.js";
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
    selection,
    visibleRanges: [{ from: 0, to: state.doc.length }],
    tree: fullTree(state),
  };
}

function spec(set: DecorationSet): Array<{ from: number; to: number; cls?: string }> {
  const out: Array<{ from: number; to: number; cls?: string }> = [];
  const iter = set.iter();
  while (iter.value !== null) {
    const s = iter.value.spec as { class?: string };
    out.push({ from: iter.from, to: iter.to, cls: s.class });
    iter.next();
  }
  return out;
}

describe("setext nascent reveal provider", () => {
  it("DE-STYLES the whole SetextHeading2 when the caret is on a lone `-` underline", () => {
    // The bug repro: "Foo\n-" → SetextHeading2 [0,5], HeaderMark [4,5] "-".
    // Caret at end of the underline line (pos 5) → the paragraph must NOT render
    // as a heading (the user is starting a bullet list, not a heading).
    const set = setextNascentReveal.build(ctx("Foo\n-", EditorSelection.single(5)));
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.cls).toBe(SETEXT_NASCENT_CLASS);
    expect(r[0]?.from).toBe(0);
    expect(r[0]?.to).toBe(5); // whole heading node (title + underline)
  });

  it("DE-STYLES a lone `=` (SetextHeading1) underline too", () => {
    // "Foo\n=" → SetextHeading1 [0,5], HeaderMark [4,5] "=".
    const set = setextNascentReveal.build(ctx("Foo\n=", EditorSelection.single(5)));
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.from).toBe(0);
    expect(r[0]?.to).toBe(5);
  });

  it("treats a single `-` with a trailing space as still lone (`Foo\\n- `)", () => {
    // The trailing space is not part of the HeaderMark ([4,5]) — the mid-typing
    // `- ` state (before content is typed) must stay de-styled.
    const set = setextNascentReveal.build(ctx("Foo\n- ", EditorSelection.single(6)));
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.from).toBe(0);
    expect(r[0]?.to).toBe(6);
  });

  it("DE-STYLES a lone dash CARET-INDEPENDENTLY (no flash when the caret moves away)", () => {
    // A lone `-` reads as a list-in-progress whether or not the caret is on it —
    // a caret-gated version would balloon the paragraph into a heading the moment
    // the caret left the underline. Caret on the title line → still de-styled.
    const set = setextNascentReveal.build(ctx("Foo\n-", EditorSelection.single(1)));
    const r = spec(set);
    expect(r.length).toBe(1);
    expect(r[0]?.from).toBe(0);
    expect(r[0]?.to).toBe(5);
  });

  it("does NOTHING for a MULTI-char `--` underline (real heading, not a nascent list)", () => {
    // "Foo\n--" → SetextHeading2, HeaderMark [4,6] "--". Two dashes read as an
    // intentional heading underline, not a nascent list marker.
    const set = setextNascentReveal.build(ctx("Foo\n--", EditorSelection.single(6)));
    expect(spec(set).length).toBe(0);
  });

  it("does NOTHING for a real `---` heading — renders as a heading as before (no regression)", () => {
    // "Foo\n---\n\nbar" → a genuine multi-char setext heading is untouched
    // regardless of caret position.
    const doc = "Foo\n---\n\nbar";
    const set = setextNascentReveal.build(ctx(doc, EditorSelection.single(doc.length)));
    expect(spec(set).length).toBe(0);
  });
});
