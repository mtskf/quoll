import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  computeInlineFormat,
  computeLinkWrap,
  type FormatAction,
} from "../../../src/webview/cm/inline/inline-formatting-commands.js";

// NO Markdown language extension: detection is pure string matching, so the
// tests deliberately construct a parser-free state. If any assertion below ever
// needed a syntax tree it would fail here — that is the regression pin proving
// unwrap does not depend on the parser (and so can't corrupt on a large doc
// where the parse is incomplete).
function stateFor(doc: string, sel: { anchor: number; head?: number }): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.range(sel.anchor, sel.head ?? sel.anchor),
  });
}

// Apply a compute result and return the resulting {doc, main range} for assertions.
function applyFormat(doc: string, sel: { anchor: number; head?: number }, action: FormatAction) {
  const state = stateFor(doc, sel);
  const { changes, selection } = computeInlineFormat(state, action);
  const next = state.update({ changes, selection }).state;
  const m = next.selection.main;
  return { doc: next.doc.toString(), from: m.from, to: m.to };
}

describe("computeInlineFormat — wrap", () => {
  it("wraps a selection in bold and keeps the inner text selected", () => {
    const r = applyFormat("foo bar", { anchor: 0, head: 3 }, "bold");
    expect(r.doc).toBe("**foo** bar");
    expect([r.from, r.to]).toEqual([2, 5]); // inner "foo" selected
  });

  it("wraps italic with single asterisks", () => {
    expect(applyFormat("foo", { anchor: 0, head: 3 }, "italic").doc).toBe("*foo*");
  });

  it("wraps inline code with backticks", () => {
    expect(applyFormat("foo", { anchor: 0, head: 3 }, "code").doc).toBe("`foo`");
  });

  it("wraps strikethrough with double tildes", () => {
    expect(applyFormat("foo", { anchor: 0, head: 3 }, "strike").doc).toBe("~~foo~~");
  });
});

describe("computeInlineFormat — unwrap (round-trip)", () => {
  it("unwraps bold when the inner text is selected", () => {
    // "**foo**" with "foo" (2..5) selected -> "foo" with "foo" (0..3) selected.
    const r = applyFormat("**foo**", { anchor: 2, head: 5 }, "bold");
    expect(r.doc).toBe("foo");
    expect([r.from, r.to]).toEqual([0, 3]);
  });

  it("unwraps bold when the whole **foo** span is selected", () => {
    expect(applyFormat("**foo**", { anchor: 0, head: 7 }, "bold").doc).toBe("foo");
  });

  it("unwraps italic (single asterisk) without touching bold", () => {
    expect(applyFormat("*foo*", { anchor: 1, head: 4 }, "italic").doc).toBe("foo");
  });

  it("wrap then unwrap is byte-identical (bold)", () => {
    const wrapped = applyFormat("foo", { anchor: 0, head: 3 }, "bold");
    expect(wrapped.doc).toBe("**foo**");
    // second press over the inner selection the wrap left:
    const back = applyFormat(wrapped.doc, { anchor: wrapped.from, head: wrapped.to }, "bold");
    expect(back.doc).toBe("foo");
  });

  it("toggling bold inside italic nests rather than corrupting the * marks", () => {
    // "*foo*" italic, select inner "foo" (1..4), press bold -> "*​**foo**​*" == "***foo***"
    expect(applyFormat("*foo*", { anchor: 1, head: 4 }, "bold").doc).toBe("***foo***");
  });

  it("removes bold from bold+italic, leaving italic (inner selected)", () => {
    // "***foo***": bold delimiters are the OUTER "**" pair; inner "foo" is 3..6.
    expect(applyFormat("***foo***", { anchor: 3, head: 6 }, "bold").doc).toBe("*foo*");
  });

  it("removes bold from a whole-selected bold+italic span", () => {
    // Whole "***foo***" (0..9) selected, press bold -> Case A strips outer "**" -> "*foo*".
    expect(applyFormat("***foo***", { anchor: 0, head: 9 }, "bold").doc).toBe("*foo*");
  });

  it("adds italic to bold rather than stripping a * (disambiguation)", () => {
    // "**foo**" inner "foo" (2..5), press ITALIC: the adjacent "*" is part of "**",
    // so it must NOT unwrap — it wraps -> "***foo***".
    expect(applyFormat("**foo**", { anchor: 2, head: 5 }, "italic").doc).toBe("***foo***");
  });

  it("does not unwrap a strict subset selection (documented limitation -> wrap)", () => {
    // "foo" inside "**foobar**" (2..5) has no adjacent delimiters, so it WRAPs.
    // The original leading "**" stays, so the literal result is "****foo**bar**"
    // (deliberately ugly — this pins the documented subset limitation, not ideal UX).
    expect(applyFormat("**foobar**", { anchor: 2, head: 5 }, "bold").doc).toBe("****foo**bar**");
  });
});

describe("computeInlineFormat — code & strike unwrap / round-trip", () => {
  it("unwraps inline code (single backtick) when the inner text is selected", () => {
    expect(applyFormat("`foo`", { anchor: 1, head: 4 }, "code").doc).toBe("foo");
  });

  it("wrap then unwrap is byte-identical (code)", () => {
    const wrapped = applyFormat("foo", { anchor: 0, head: 3 }, "code");
    expect(wrapped.doc).toBe("`foo`");
    expect(applyFormat(wrapped.doc, { anchor: wrapped.from, head: wrapped.to }, "code").doc).toBe(
      "foo"
    );
  });

  it("unwraps strikethrough (double tilde) when the inner text is selected", () => {
    expect(applyFormat("~~foo~~", { anchor: 2, head: 5 }, "strike").doc).toBe("foo");
  });

  it("wrap then unwrap is byte-identical (strike)", () => {
    const wrapped = applyFormat("foo", { anchor: 0, head: 3 }, "strike");
    expect(wrapped.doc).toBe("~~foo~~");
    expect(applyFormat(wrapped.doc, { anchor: wrapped.from, head: wrapped.to }, "strike").doc).toBe(
      "foo"
    );
  });
});

describe("computeInlineFormat — empty selection", () => {
  it("inserts a bold marker pair with the caret between them", () => {
    const r = applyFormat("", { anchor: 0 }, "bold");
    expect(r.doc).toBe("****");
    expect([r.from, r.to]).toEqual([2, 2]);
  });

  it("inserts an inline-code pair with the caret between", () => {
    const r = applyFormat("", { anchor: 0 }, "code");
    expect(r.doc).toBe("``");
    expect([r.from, r.to]).toEqual([1, 1]);
  });
});

describe("computeLinkWrap", () => {
  it("wraps a selection as [text]() with the caret in the empty url slot", () => {
    const state = stateFor("foo", { anchor: 0, head: 3 });
    const { changes, selection } = computeLinkWrap(state);
    const next = state.update({ changes, selection }).state;
    expect(next.doc.toString()).toBe("[foo]()");
    expect(next.selection.main.empty).toBe(true);
    expect(next.selection.main.from).toBe(6); // between ( and )
  });

  it("reuses url when provided (paste-URL sibling reuse)", () => {
    const state = stateFor("foo", { anchor: 0, head: 3 });
    const { changes } = computeLinkWrap(state, "https://x.test");
    const next = state.update({ changes }).state;
    expect(next.doc.toString()).toBe("[foo](https://x.test)");
  });

  it("empty selection inserts []() with the caret in the text slot", () => {
    const state = stateFor("", { anchor: 0 });
    const { changes, selection } = computeLinkWrap(state);
    const next = state.update({ changes, selection }).state;
    expect(next.doc.toString()).toBe("[]()");
    expect(next.selection.main.from).toBe(1); // inside []
  });
});
