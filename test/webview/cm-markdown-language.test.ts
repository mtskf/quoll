// @vitest-environment happy-dom
//
// Pins the DIRECTLY-BUILT editor language (quollMarkdownLanguage,
// src/webview/cm/markdown.ts) against the upstream markdown() wrapper it
// replaces. The pre-existing suites do NOT cover the direct build:
// cm-decoration-integration mounts markdown({ base }); cm-fold-delegation
// likewise. These four contracts are what the refactor must preserve:
//   1. markdownLanguage.isActiveAt is true on the built language — proves the
//      reused markdownLanguage.data facet (markdownKeymap's commands and
//      pasteURLAsLink early-return without it, since isActiveAt compares the
//      languageDataProp facet identity, not the Language instance).
//   2/3. markdownKeymap (Enter/Backspace) and pasteURLAsLink are wired + active.
//   4. the re-implemented headerIndent folds heading lines byte-identically to
//      upstream markdown({ base }) — a parity oracle across heading fixtures.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeFolding, ensureSyntaxTree, foldable } from "@codemirror/language";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";

const quollLang = quollMarkdownLanguage();
const upstreamLang = markdown({ base: markdownLanguage });

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string, anchor: number, selEnd = anchor): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.range(anchor, selEnd),
      extensions: [quollLang],
    }),
  });
  ensureSyntaxTree(view.state, view.state.doc.length, 5000);
  return view;
}

describe("quollMarkdownLanguage reuses markdownLanguage.data (isActiveAt)", () => {
  it("markdownLanguage.isActiveAt is true inside the directly-built language", () => {
    // The load-bearing invariant: building with a FRESH facet would silently
    // disable markdownKeymap + pasteURLAsLink. State-only, no view needed.
    const state = EditorState.create({ doc: "hello world", extensions: [quollLang] });
    expect(markdownLanguage.isActiveAt(state, 3, 1)).toBe(true);
  });
});

describe("quollMarkdownLanguage wires the active markdownKeymap", () => {
  it("Enter continues a list marker (insertNewlineContinueMarkup via the keymap)", () => {
    const v = mount("- alpha", "- alpha".length);
    const handled = runScopeHandlers(v, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
    expect(handled).toBe(true);
    expect(v.state.sliceDoc()).toBe("- alpha\n- ");
  });

  it("Backspace after a list marker deletes it (deleteMarkupBackward via the keymap)", () => {
    const v = mount("- alpha", 2); // caret right after "- "
    const handled = runScopeHandlers(v, new KeyboardEvent("keydown", { key: "Backspace" }), "editor");
    expect(handled).toBe(true);
    // Upstream deleteMarkupBackward removes the bullet marker; assert the "- "
    // prefix is gone (exact remainder pinned so a broken keymap reds this).
    expect(v.state.sliceDoc()).toBe("alpha");
  });
});

describe("quollMarkdownLanguage wires pasteURLAsLink", () => {
  it("pasting a URL over a text selection wraps it as a link", () => {
    const v = mount("select me", 0, "select".length); // select "select"
    // pasteURLAsLink is an EditorView.domEventHandlers({ paste }) — dispatch a
    // real paste event carrying a text/plain URL. clipboardData is attached
    // explicitly for determinism across happy-dom versions.
    const ev = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { getData: (t: string) => (t === "text/plain" ? "https://example.com" : "") },
    });
    v.contentDOM.dispatchEvent(ev);
    expect(v.state.sliceDoc()).toBe("[select](https://example.com) me");
  });
});

describe("re-implemented headerIndent folds byte-identically to upstream", () => {
  // The parity oracle for the section-boundary math. Compare foldable() on the
  // HEADING line only (quollLang's nonFoldableBlocks subtraction diverges from
  // upstream on blockquote/paragraph/code lines by design — headings are the
  // shared contract). A wrong sectionEnd/headingLevel diverges from upstream.
  // The blockquote-wrapped-heading fixture pins the exact from/to that
  // cm-fold-blockquote.test.ts only asserts `not.toBeNull()` for.
  function foldHeadingRange(lang: Extension, doc: string, headAt: number) {
    const state = EditorState.create({ doc, extensions: [lang, codeFolding()] });
    ensureSyntaxTree(state, state.doc.length, 5000);
    const line = state.doc.lineAt(headAt);
    return foldable(state, line.from, line.to);
  }

  const FIXTURES: Array<{ doc: string; headAt: number }> = [
    { doc: "# A\nbody1\nbody2\n# B\n", headAt: 0 }, // simple section
    { doc: "# A\n## A1\ntext\n# B\n", headAt: 0 }, // spans lower subheading
    { doc: "## H2 only\nbody\nmore\n", headAt: 0 }, // trailing section to EOF
    { doc: "Setext\n===\n\nbody\ntail\n", headAt: 0 }, // setext H1
    { doc: "# top\nintro\n### deep\nx\ny\n# end\n", headAt: 0 }, // top spans H3
    { doc: "> # A\n> body\n> # B\n", headAt: 0 }, // heading INSIDE a blockquote
  ];

  for (const { doc, headAt } of FIXTURES) {
    it(`matches upstream fold range for ${JSON.stringify(doc.slice(0, 14))}…`, () => {
      const q = foldHeadingRange(quollLang, doc, headAt);
      const u = foldHeadingRange(upstreamLang, doc, headAt);
      expect(q).not.toBeNull(); // headings must stay foldable...
      expect(q).toEqual(u); // ...with byte-identical from/to to upstream.
    });
  }
});
