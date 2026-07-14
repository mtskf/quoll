// @vitest-environment happy-dom
//
// Pins PR2's code-block syntax highlighting. Part A (this file, Task 1): nesting
// activation, prototype-safe lookup (a ```constructor fence must not crash the parse),
// display-only rendering, and picker<->parser-registry sync. Part B (appended in Task 2)
// adds the language-scoped styling pins.
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  codeParserFor,
  HIGHLIGHT_UNSUPPORTED,
} from "../../src/webview/cm/fenced-code/fenced-code-highlight-languages.js";
import { LANGUAGE_OPTIONS } from "../../src/webview/cm/fenced-code/fenced-code-languages.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";

const lang = quollMarkdownLanguage();
const FENCED = ["```js", "const x = 1 // hi", "```", ""].join("\n");

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const v = new EditorView({ parent, state: EditorState.create({ doc, extensions: [lang] }) });
  ensureSyntaxTree(v.state, v.state.doc.length, 5000);
  view = v;
  return v;
}

describe("code block nested parsing", () => {
  it("nests a sub-language inside a ```js fence (interior is not a bare CodeText leaf)", () => {
    const state = EditorState.create({ doc: FENCED, extensions: [lang] });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(tree).not.toBeNull();
    const codeStart = FENCED.indexOf("const");
    const names = new Set<string>();
    for (let n = tree!.resolveInner(codeStart, 1); n; n = n.parent as typeof n) {
      names.add(n.type.name);
    }
    expect(names).toContain("FencedCode");
    expect(tree!.resolveInner(codeStart, 1).type.name).not.toBe("CodeText");
  });

  it("codeParserFor maps known ids, strips info, and is case-insensitive", () => {
    expect(codeParserFor("js")).not.toBeNull();
    expect(codeParserFor("ts")).not.toBeNull();
    expect(codeParserFor("python")).not.toBeNull();
    expect(codeParserFor("JS")).not.toBeNull();
    expect(codeParserFor('js title="x"')).not.toBeNull(); // first token only
    expect(codeParserFor("  ")).toBeNull();
    expect(codeParserFor("")).toBeNull();
    expect(codeParserFor("not-a-language")).toBeNull();
  });

  it("is prototype-safe: inherited Object members resolve to null, not a crash", () => {
    for (const evil of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(codeParserFor(evil)).toBeNull();
    }
    expect(() => mount(["```constructor", "x", "```", ""].join("\n"))).not.toThrow();
  });
});

describe("display-only (no serialization / no text mutation)", () => {
  it("leaves the document and the rendered text byte-identical to the source", () => {
    const v = mount(FENCED);
    expect(v.state.sliceDoc()).toBe(FENCED);
    expect(v.contentDOM.textContent).toContain("const x = 1 // hi"); // no replacing deco
  });
});

describe("picker registry <-> highlight registry stay in sync", () => {
  it("every picker language either highlights or is an explicit documented exception", () => {
    for (const { value } of LANGUAGE_OPTIONS) {
      if (value === "") {
        continue;
      }
      if (HIGHLIGHT_UNSUPPORTED.has(value)) {
        expect(codeParserFor(value)).toBeNull();
      } else {
        expect(codeParserFor(value)).not.toBeNull();
      }
    }
  });
});
