import { EditorSelection, EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import {
  applyCaret,
  type Caret,
  selectionCharCount,
  selectionToCaret,
} from "../../src/webview/cm/caret.js";

function stateWith(doc: string, head: number): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.cursor(head) });
}

describe("selectionToCaret", () => {
  it("maps the first character to {line:0, character:0}", () => {
    expect(selectionToCaret(stateWith("abc\ndef", 0))).toEqual({ line: 0, character: 0 });
  });

  it("maps an offset mid-first-line to character within line 0", () => {
    expect(selectionToCaret(stateWith("abc\ndef", 2))).toEqual({ line: 0, character: 2 });
  });

  it("maps the start of the second line to {line:1, character:0}", () => {
    // "abc\n" => offset 4 is the first char of line 2 (0-based line 1).
    expect(selectionToCaret(stateWith("abc\ndef", 4))).toEqual({ line: 1, character: 0 });
  });

  it("maps an offset mid-second-line", () => {
    expect(selectionToCaret(stateWith("abc\ndef", 6))).toEqual({ line: 1, character: 2 });
  });

  it("reads the MAIN range head of a multi-range selection", () => {
    const state = EditorState.create({
      doc: "abc\ndef",
      selection: EditorSelection.create(
        [EditorSelection.cursor(1), EditorSelection.cursor(6)],
        1 // mainIndex → head at offset 6
      ),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    expect(selectionToCaret(state)).toEqual({ line: 1, character: 2 });
  });
});

describe("selectionCharCount", () => {
  it("is 0 for a collapsed selection (cursor)", () => {
    expect(selectionCharCount(stateWith("abc\ndef", 2))).toBe(0);
  });

  it("counts the primary range extent (to - from)", () => {
    const state = EditorState.create({
      doc: "abc\ndef",
      selection: EditorSelection.range(1, 6), // spans 5 code units across the newline
    });
    expect(selectionCharCount(state)).toBe(5);
  });

  it("reads the MAIN range of a multi-range selection", () => {
    const state = EditorState.create({
      doc: "abcdef",
      selection: EditorSelection.create(
        [EditorSelection.range(0, 1), EditorSelection.range(2, 5)],
        1 // mainIndex → the 3-wide range
      ),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });
    expect(selectionCharCount(state)).toBe(3);
  });
});

describe("applyCaret", () => {
  const doc = Text.of(["abc", "def"]); // offsets: a0 b1 c2 \n3 d4 e5 f6

  it("maps {line:0, character:0} to offset 0", () => {
    expect(applyCaret(doc, { line: 0, character: 0 })).toBe(0);
  });

  it("maps {line:1, character:2} to offset 6", () => {
    expect(applyCaret(doc, { line: 1, character: 2 })).toBe(6);
  });

  it("clamps an over-large line to the last line", () => {
    // line 99 clamps to line 1 (last), character 0 => offset 4.
    expect(applyCaret(doc, { line: 99, character: 0 })).toBe(4);
  });

  it("clamps an over-large character to the end of the line", () => {
    // line 0 has length 3 => character 99 clamps to 3 => offset 3.
    expect(applyCaret(doc, { line: 0, character: 99 })).toBe(3);
  });

  it("clamps a negative line/character to 0", () => {
    const c: Caret = { line: -5, character: -5 };
    expect(applyCaret(doc, c)).toBe(0);
  });

  it("round-trips with selectionToCaret", () => {
    const state = EditorState.create({
      doc: "hello\nworld\n!",
      selection: EditorSelection.cursor(8),
    });
    const caret = selectionToCaret(state);
    expect(applyCaret(state.doc, caret)).toBe(8);
  });
});
