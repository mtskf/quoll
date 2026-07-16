import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/markdown/lezer-url-walker.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";

// Pins that the HOST write-gate parser (parseMarkdown) and the WEBVIEW editor
// language (quollMarkdownLanguage()) agree on Highlight extraction for the
// inputs that matter. NOT whole-tree equality (the webview nests code
// sub-languages, so fenced-code subtrees legitimately differ) — only the
// Highlight/HighlightMark spans are compared, plus the "no Highlight inside
// code" cases must agree in BOTH.

/** Highlight/HighlightMark spans from the HOST parser. */
function hostHl(src: string): string[] {
  const out: string[] = [];
  parseMarkdown(src).iterate({
    enter: (n) => {
      if (n.name === "Highlight" || n.name === "HighlightMark") {
        out.push(`${n.name}[${n.from},${n.to})`);
      }
    },
  });
  return out;
}

/** Highlight/HighlightMark spans from the WEBVIEW editor language. */
function webviewHl(src: string): string[] {
  const state = EditorState.create({ doc: src, extensions: [quollMarkdownLanguage()] });
  const out: string[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name === "Highlight" || n.name === "HighlightMark") {
        out.push(`${n.name}[${n.from},${n.to})`);
      }
    },
  });
  return out;
}

describe("host↔webview Highlight parity", () => {
  it.each([
    "==plain==",
    "==[x](https://example.com)==",
    "==![alt](https://example.com/i.png)==",
    "==*x*==",
    "before ==mid== after",
    "`==notmark==`", // inside a code span → NO Highlight in either parser
    "```\n==notmark==\n```\n", // inside fenced code → NO Highlight in either parser
    "| a | b |\n| - | - |\n| ==c== | d |\n", // inside a table cell
  ])("host and webview agree on Highlight spans for %j", (src) => {
    expect(webviewHl(src)).toEqual(hostHl(src));
  });
});
