import { syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "../../src/markdown/lezer-url-walker.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { fullTree } from "./helpers/full-tree.js";

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
  // Walk the returned tree only (never read back through `state`), so `fullTree`
  // is the right helper here: a freshly-created state's `syntaxTree(state)`
  // snapshot can be truncated under load, which would drop Highlight spans.
  fullTree(state).iterate({
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

  // Guard the table-cell row above against a vacuous []===[] pass: both parsers
  // must ACTUALLY produce a Highlight inside a table cell (the source-level parse
  // is what agrees — the table *widget* renderer not painting the highlight is a
  // separate, deferred gap tracked in TODO, not asserted here).
  it("the table-cell case is non-vacuous — both parsers produce a Highlight", () => {
    const src = "| a | b |\n| - | - |\n| ==c== | d |\n";
    expect(hostHl(src).length).toBeGreaterThan(0);
    expect(webviewHl(src).length).toBeGreaterThan(0);
  });
});

// Non-vacuity for the `fullTree` in `webviewHl`, taken STRUCTURALLY: `LanguageState.init`
// caps its init viewport at 3000 characters, so a longer document ALWAYS starts with a
// truncated snapshot regardless of CPU load. This is the returned-tree class of the
// migration — nothing here reads back through the state, so `fullTree` is exactly the
// right helper and `settledState` would be the heavier one.
//
// Revert-check, measured: put `syntaxTree(state)` back in `webviewHl` and the third
// assertion below reds; nothing else in this file changes.
describe("the parity harness walks a complete tree, not a truncated snapshot", () => {
  const PAD = "filler paragraph text\n\n".repeat(200); // > 3000 chars
  const SRC = `${PAD}==far==\n`;

  it("a freshly-created state's snapshot is truncated (the precondition)", () => {
    const state = EditorState.create({ doc: SRC, extensions: [quollMarkdownLanguage()] });
    expect(syntaxTree(state).length).toBeLessThan(state.doc.length);
  });

  it("fullTree spans the whole doc", () => {
    const state = EditorState.create({ doc: SRC, extensions: [quollMarkdownLanguage()] });
    expect(fullTree(state).length).toBe(state.doc.length);
  });

  it("the truncated snapshot loses the Highlight that the complete tree finds", () => {
    const state = EditorState.create({ doc: SRC, extensions: [quollMarkdownLanguage()] });
    const truncated: string[] = [];
    syntaxTree(state).iterate({
      enter: (n) => {
        if (n.name === "Highlight") {
          truncated.push(n.name);
        }
      },
    });
    expect(truncated).toEqual([]); // the flake's shape
    expect(webviewHl(SRC)).toContain(`Highlight[${PAD.length},${PAD.length + "==far==".length})`);
  });
});
