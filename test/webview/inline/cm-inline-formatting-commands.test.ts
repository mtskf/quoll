import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { gfmParser } from "../../../src/markdown/gfm-parser.js";
import type { FormatAction } from "../../../src/shared/protocol.js";
import {
  computeInlineFormat,
  computeLinkWrap,
} from "../../../src/webview/cm/inline/inline-formatting-commands.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";

// NO Markdown language extension: bold, italic and strike never read the
// editor's syntax tree, so their tests deliberately construct a tree-free state.
// If any of those assertions ever needed that tree it would fail here — that is
// the regression pin proving their unwrap does not depend on the time-budgeted
// parse (and so can't corrupt on a large doc where that parse is incomplete).
function stateFor(doc: string, sel: { anchor: number; head?: number }): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.range(sel.anchor, sel.head ?? sel.anchor),
  });
}

// Code reads the editor's tree, so its tests run with the editor's language.
function codeStateFor(doc: string, sel: { anchor: number; head?: number }): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.range(sel.anchor, sel.head ?? sel.anchor),
    extensions: [quollMarkdownLanguage()],
  });
}

// Apply a compute result and return the resulting {doc, main range} for assertions.
function applyFormat(doc: string, sel: { anchor: number; head?: number }, action: FormatAction) {
  const state = action === "code" ? codeStateFor(doc, sel) : stateFor(doc, sel);
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

  it.each([
    ["a]b", "[a&#93;b]()"],
    ["**bold**", "[**bold**]()"],
  ])("wraps %s with the caret in the empty URL slot", (label, source) => {
    const state = stateFor(`before ${label} after`, {
      anchor: 7,
      head: 7 + label.length,
    });
    const { changes, selection } = computeLinkWrap(state);
    const next = state.update({ changes, selection }).state;
    expect(next.doc.toString()).toBe(`before ${source} after`);
    expect(next.selection.main.empty).toBe(true);
    expect(next.selection.main.from).toBe(7 + source.length - 1);
  });

  it("empty selection inserts []() with the caret in the text slot", () => {
    const state = stateFor("", { anchor: 0 });
    const { changes, selection } = computeLinkWrap(state);
    const next = state.update({ changes, selection }).state;
    expect(next.doc.toString()).toBe("[]()");
    expect(next.selection.main.from).toBe(1); // inside []
  });
});

// The rendered body of the document's code spans, read through the real GFM
// parser: the bytes between the first and last CodeMark of each InlineCode,
// with the one-space strip CommonMark applies when both ends are spaces and the
// body is not all spaces.
function renderedCodeBodies(doc: string): string[] {
  const bodies: string[] = [];
  gfmParser.parse(doc).iterate({
    enter(node) {
      if (node.name !== "InlineCode") {
        return;
      }
      const marks = node.node.getChildren("CodeMark");
      const raw = doc.slice(marks[0].to, marks[marks.length - 1].from);
      bodies.push(
        raw.length >= 2 && raw.startsWith(" ") && raw.endsWith(" ") && /[^ ]/.test(raw)
          ? raw.slice(1, -1)
          : raw
      );
      return false;
    },
  });
  return bodies;
}

describe("computeInlineFormat — code keeps the whole selection", () => {
  const cases = [
    ["an inner backtick", "a`b"],
    ["a backtick run", "a``b"],
    ["several runs", "a`b``c"],
    ["a leading backtick", "`a"],
    ["a trailing backtick", "a`"],
    ["spaces at both ends", " a "],
    ["spaces and a backtick", " a`b "],
    ["only backticks", "``"],
    ["only spaces", "  "],
  ] as const;

  for (const [name, text] of cases) {
    it(`renders a selection with ${name} as one code span of exactly that text`, () => {
      const doc = `x ${text} y`;
      const r = applyFormat(doc, { anchor: 2, head: 2 + text.length }, "code");
      expect(renderedCodeBodies(r.doc)).toEqual([text]);
      expect(r.doc.slice(r.from, r.to)).toBe(text);
    });

    it(`toggles a selection with ${name} back to the original bytes`, () => {
      const doc = `x ${text} y`;
      const once = applyFormat(doc, { anchor: 2, head: 2 + text.length }, "code");
      const twice = applyFormat(once.doc, { anchor: once.from, head: once.to }, "code");
      expect(twice.doc).toBe(doc);
      expect(twice.doc.slice(twice.from, twice.to)).toBe(text);
    });

    it(`unwraps a whole selected span with ${name}`, () => {
      const doc = `x ${text} y`;
      const once = applyFormat(doc, { anchor: 2, head: 2 + text.length }, "code");
      const spanTo = once.doc.length - 2;
      const r = applyFormat(once.doc, { anchor: 2, head: spanTo }, "code");
      expect(r.doc).toBe(doc);
      expect(r.doc.slice(r.from, r.to)).toBe(text);
    });
  }

  it("unwraps a hand-written double-backtick span from its inner text", () => {
    expect(applyFormat("``a`b``", { anchor: 2, head: 5 }, "code").doc).toBe("a`b");
  });

  it("unwraps a hand-written double-backtick span selected whole", () => {
    expect(applyFormat("`` a`b ``", { anchor: 0, head: 9 }, "code").doc).toBe("a`b");
  });

  it("leaves a selection that borders a backtick unchanged", () => {
    // `` ``a` `` is not one span, and a fence beside a backtick would merge with it.
    const r = applyFormat("``a`", { anchor: 2, head: 3 }, "code");
    expect(r.doc).toBe("``a`");
    expect([r.from, r.to]).toEqual([2, 3]);
  });

  it("leaves a selection that ends at a backtick outside it unchanged", () => {
    // Fencing "a`b" here would join the trailing backtick into the closing fence.
    const doc = "x `a`b` y";
    const r = applyFormat(doc, { anchor: 3, head: 6 }, "code");
    expect(r.doc).toBe(doc);
    expect([r.from, r.to]).toEqual([3, 6]);
  });

  it.each([
    ["on one line", "run `npm` install `foo` now", "install", ["npm", "install", "foo"]],
    ["across lines", "see `a`\nb\n`c` here", "b", ["a", "b", "c"]],
  ])("wraps text between two code spans %s instead of joining them", (_, doc, text, bodies) => {
    const from = doc.indexOf(text);
    const r = applyFormat(doc, { anchor: from, head: from + text.length }, "code");
    expect(renderedCodeBodies(r.doc)).toEqual(bodies);
    expect(r.doc.slice(r.from, r.to)).toBe(text);
  });

  it("keeps the fences of a selected fenced code block", () => {
    const doc = "```\nconst x = 1;\n```";
    const r = applyFormat(doc, { anchor: 0, head: doc.length }, "code");
    expect(renderedCodeBodies(r.doc)).toEqual([doc]);
    expect(r.doc.slice(r.from, r.to)).toBe(doc);
  });

  it("unwraps a span inside a list item", () => {
    expect(applyFormat("- a `b` c", { anchor: 5, head: 6 }, "code").doc).toBe("- a b c");
  });

  it("unwraps a span that crosses a line break", () => {
    expect(applyFormat("x `a\nb` y", { anchor: 3, head: 6 }, "code").doc).toBe("x a\nb y");
  });

  it("leaves the document as it is while the editor has no syntax tree", () => {
    const state = stateFor("foo", { anchor: 0, head: 3 });
    const { changes, selection } = computeInlineFormat(state, "code");
    const next = state.update({ changes, selection }).state;
    expect(next.doc.toString()).toBe("foo");
    expect([next.selection.main.from, next.selection.main.to]).toEqual([0, 3]);
  });

  it.each([
    ["an ordered list continuation", "1. First\n\n    para with `code` here", "code"],
    ["a nested loose list", "- a\n\n  - b\n\n    - c `d` e", "d"],
    ["a wide list marker's continuation", "10. item\n\n    cont `x` end", "x"],
    ["a paragraph after a fenced block with a blank line", "```\na\n\nb\n```\n`c` d", "c"],
  ])("unwraps a span in %s", (_, doc, text) => {
    const from = doc.indexOf(`\`${text}\``) + 1;
    const r = applyFormat(doc, { anchor: from, head: from + text.length }, "code");
    expect(r.doc).toBe(doc.replace(`\`${text}\``, text));
    expect(r.doc.slice(r.from, r.to)).toBe(text);
  });

  it.each([
    ["its inner text", 1, 4],
    ["the whole span", 0, 5],
  ])("leaves backticks inside a fenced block with a blank line alone when %s is selected", (_, start, end) => {
    const doc = "```\nx\n\n`foo`\n```";
    const at = doc.indexOf("`foo`");
    const r = applyFormat(doc, { anchor: at + start, head: at + end }, "code");
    expect(r.doc).toBe(doc);
  });

  it("fences past an unmatched backtick earlier in the paragraph", () => {
    const doc = "x ` y foo";
    const from = doc.indexOf("foo");
    const r = applyFormat(doc, { anchor: from, head: from + 3 }, "code");
    expect(renderedCodeBodies(r.doc)).toEqual(["foo"]);
    expect(r.doc.startsWith("x ` y ")).toBe(true);
    expect(r.doc.slice(r.from, r.to)).toBe("foo");
  });

  it.each([
    ["the middle of a span", "`foobar`", 2, 5],
    ["the end of a span and text after it", "`ab` c", 2, 6],
  ])("leaves the document as it is when the selection is %s", (_, doc, start, end) => {
    const r = applyFormat(doc, { anchor: start, head: end }, "code");
    expect(r.doc).toBe(doc);
    expect([r.from, r.to]).toEqual([start, end]);
  });

  it("leaves the document as it is when the selection starts a span and ends inside it", () => {
    // Fencing "`a" would render it whole, but only by breaking `ab` apart.
    const doc = "`ab` c";
    const r = applyFormat(doc, { anchor: 0, head: 2 }, "code");
    expect(r.doc).toBe(doc);
    expect([r.from, r.to]).toEqual([0, 2]);
  });

  it("leaves part of an indented code block alone", () => {
    // Fencing from the line start would end the code block and render that
    // text as a code span in a paragraph.
    const doc = "para\n\n    code `x` here\n";
    const from = doc.indexOf("    code");
    const to = from + "    code".length;
    const r = applyFormat(doc, { anchor: from, head: to }, "code");
    expect(r.doc).toBe(doc);
    expect([r.from, r.to]).toEqual([from, to]);
  });

  it("leaves the document as it is when the fence would open a fenced block at a line start", () => {
    // Earlier runs of 1 and 2 push the fence to three backticks, which at the
    // start of a line opens a fenced code block instead of a code span.
    const doc = "x ` and ``\nfoo\nbar rest\ntrailing";
    const from = doc.indexOf("foo");
    const to = doc.indexOf(" rest");
    const r = applyFormat(doc, { anchor: from, head: to }, "code");
    expect(r.doc).toBe(doc);
    expect([r.from, r.to]).toEqual([from, to]);
  });

  describe("after the parse has run ahead of the state's stored tree", () => {
    // About 112KB: the state's own parse stops short of the tail, and
    // ensureSyntaxTree advances only the parse, not the tree the state holds.
    const filler = "lorem ipsum dolor sit amet\n\n".repeat(4000);
    const doc = `${filler}tail \`foobar\` end`;
    const span = doc.indexOf("`foobar`");

    function parsedAhead(start: number, end: number): EditorState {
      const state = codeStateFor(doc, { anchor: start, head: end });
      ensureSyntaxTree(state, doc.length, 20_000);
      expect(syntaxTree(state).length).toBeLessThan(doc.length);
      return state;
    }

    function run(state: EditorState): string {
      return state.update(computeInlineFormat(state, "code")).state.doc.toString();
    }

    it("unwraps a whole selected span past the stored tree's end", () => {
      expect(run(parsedAhead(span, span + 8))).toBe(`${filler}tail foobar end`);
    });

    it("leaves the middle of a span past the stored tree's end alone", () => {
      expect(run(parsedAhead(span + 2, span + 5))).toBe(doc);
    });
  });
});
