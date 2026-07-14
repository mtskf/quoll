// @vitest-environment happy-dom
//
// Pins PR2's code-block syntax highlighting. Part A (this file, Task 1): nesting
// activation, prototype-safe lookup (a ```constructor fence must not crash the parse),
// display-only rendering, and picker<->parser-registry sync. Part B (appended in Task 2)
// adds the language-scoped styling pins.
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { highlightTree, tags as t } from "@lezer/highlight";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_LANGUAGES,
  codeHighlightStyles,
  codeParserFor,
  HIGHLIGHT_UNSUPPORTED,
} from "../../src/webview/cm/fenced-code/fenced-code-highlight-languages.js";
import { LANGUAGE_OPTIONS } from "../../src/webview/cm/fenced-code/fenced-code-languages.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { quollCodeHighlightSpec } from "../../src/webview/cm/theme.js";

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

// Collect the highlight classes the scoped code styles assign inside [from,to). Feeds
// highlightTree directly, exactly as the runtime treeHighlighter does.
function codeClassesAt(doc: string, needle: string): string[] {
  const state = EditorState.create({ doc, extensions: [lang] });
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (!tree) {
    throw new Error("no tree");
  }
  const from = doc.indexOf(needle);
  const to = from + needle.length;
  const out: string[] = [];
  highlightTree(
    tree,
    codeHighlightStyles,
    (f, tt, cls) => {
      if (f < to && tt > from) {
        out.push(cls);
      }
    },
    from,
    to
  );
  return out;
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

  it("skips nested parsing for code blocks over the size cap (protects parse budgets)", () => {
    // A mapped fence far larger than any real snippet (>50KB) must NOT be nested-parsed:
    // the mixed parser is ~10-25x slower and would stress the synchronous full-doc
    // ensureSyntaxTree(..., 50ms) hot paths. Rendered opaque (plain CodeText leaf) instead.
    const huge = `${"x = 1\n".repeat(10000)}`; // ~60KB of code body
    const doc = `\`\`\`js\n${huge}\`\`\`\n`;
    const state = EditorState.create({ doc, extensions: [lang] });
    const tree = ensureSyntaxTree(state, state.doc.length, 5000);
    expect(tree).not.toBeNull();
    const codeStart = doc.indexOf("x = 1");
    // Interior stays a bare CodeText leaf — no sub-language mount above the cap.
    expect(tree!.resolveInner(codeStart, 1).type.name).toBe("CodeText");
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

describe("code highlight spec", () => {
  const codeTags = new Set(quollCodeHighlightSpec.flatMap((s) => [s.tag].flat()));

  it("covers the core code token kinds keyed to theme-aware CSS vars", () => {
    for (const tag of [t.keyword, t.string, t.comment, t.number, t.typeName]) {
      expect(codeTags.has(tag)).toBe(true);
    }
    const colours = quollCodeHighlightSpec
      .map((s) => s.color)
      .filter((c): c is string => typeof c === "string");
    expect(colours.length).toBeGreaterThan(0);
    for (const c of colours) {
      expect(c).toMatch(/var\(--/); // theme-aware, no hard-coded hex
    }
  });

  it("builds one scoped HighlightStyle per nested language", () => {
    expect(codeHighlightStyles.length).toBe(CODE_LANGUAGES.length);
  });
});

describe("scoped highlighting styles code but NOT prose (the leak guard)", () => {
  it("styles a keyword inside a ```js fence", () => {
    expect(codeClassesAt(FENCED, "const").length).toBeGreaterThan(0);
  });

  it("does NOT style a GFM TaskMarker (t.atom leaks through t.keyword ancestry if unscoped)", () => {
    // Regression pin for the ancestry leak: TaskMarker → t.atom → child of t.keyword.
    // With language scoping the code palette never touches this outer-Markdown node.
    expect(codeClassesAt("- [ ] todo\n", "[ ]")).toEqual([]);
  });

  it("does NOT style a LinkTitle (t.string) in prose", () => {
    expect(codeClassesAt('[a](/x "ttl")\n', "ttl")).toEqual([]);
  });
});
