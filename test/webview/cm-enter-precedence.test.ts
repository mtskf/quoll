// @vitest-environment happy-dom
//
// Pins the effective Enter-handler precedence when Quoll's structural Enter
// keymaps are composed with the upstream `markdownKeymap` — the exact contest
// editor.ts sets up. quollMarkdownLanguage() mounts the upstream Enter
// (`insertNewlineContinueMarkup`) at Prec.high; the language is registered FIRST,
// so at equal precedence upstream shadowed Quoll's handlers in list contexts
// (equal-precedence keymaps resolve in registration order). Quoll's list +
// fenced-code Enter handlers are therefore mounted at Prec.highest, giving one
// deliberate order (highest→lowest): list continuation → fenced-code auto-close →
// upstream markup continuation → CM default newline. This suite mirrors that mount
// (same factories, same order) so it pins the real behaviour, not a reconstruction.

import { defaultKeymap } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState, Prec, type SelectionRange } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { fencedCodeEnterKeymap } from "../../src/webview/cm/fenced-code/fenced-code-enter-keymap.js";
import {
  continueListOnEnter,
  listContinuationKeymap,
} from "../../src/webview/cm/list/list-continuation-keymap.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";

/** Mount the same Enter-relevant extension slice editor.ts composes, in the same
 *  order: language (carries upstream markdownKeymap @ Prec.high) → Quoll list
 *  Enter → Quoll fenced Enter (both @ Prec.highest) → CM default newline. */
function mount(doc: string, caret: number): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: [
      quollMarkdownLanguage(),
      listContinuationKeymap(),
      fencedCodeEnterKeymap(),
      Prec.default(keymap.of(defaultKeymap)),
    ],
  });
  const view = new EditorView({ state, parent });
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

function pressEnter(view: EditorView): boolean {
  return runScopeHandlers(
    view,
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    "editor"
  );
}

/** Canonical Quoll list-continuation output for a doc/caret, via the command
 *  directly (bypassing the keymap). Used to assert the dispatched Enter routed to
 *  Quoll's command rather than the upstream markup handler. */
function quollListDirect(doc: string, caret: number): string {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret) as SelectionRange,
    extensions: [quollMarkdownLanguage()],
  });
  const view = new EditorView({ state, parent });
  forceParsing(view, view.state.doc.length, 5_000);
  continueListOnEnter(view);
  const out = view.state.doc.toString();
  view.destroy();
  return out;
}

describe("Enter precedence — Quoll structural handlers vs upstream markdownKeymap", () => {
  it("list context: Quoll's list continuation wins over upstream (task → unchecked marker)", () => {
    // Upstream `insertNewlineContinueMarkup` would continue only the `- ` mark;
    // Quoll continues a task as an ALWAYS-unchecked `- [ ] `. The `[ ]` is the
    // unambiguous fingerprint that Quoll's handler ran, not upstream's.
    const view = mount("- [x] done", "- [x] done".length);
    try {
      expect(pressEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x] done\n- [ ] ");
    } finally {
      view.destroy();
    }
  });

  it("list context: Quoll's ordered renumber wins (upstream leaves a non-sequential run)", () => {
    // `1. a` + Enter on a run whose next item is `5. b`: Quoll inserts `2. ` and
    // renumbers the tail; upstream inserts `2. ` but leaves `5. b`. Assert the
    // dispatched result matches Quoll's command-direct output (proves Quoll won).
    const doc = "1. a\n5. b";
    const caret = 4; // end of "1. a"
    const view = mount(doc, caret);
    try {
      expect(pressEnter(view)).toBe(true);
      const dispatched = view.state.doc.toString();
      expect(dispatched).toBe(quollListDirect(doc, caret));
      // Guard the distinguisher: upstream would have left "5. b" untouched.
      expect(dispatched).not.toContain("5. b");
    } finally {
      view.destroy();
    }
  });

  it("fenced-code context: Quoll's auto-close wins over upstream / default newline", () => {
    const view = mount("```js", "```js".length);
    try {
      expect(pressEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```js\n\n```");
    } finally {
      view.destroy();
    }
  });

  it("fence opener on a list-marker line: list handler defers, fenced handler wins", () => {
    // `- ```js`: continueListOnEnter defers (caretInCode) so the fence auto-close
    // runs — pins the list-before-fence order at Prec.highest, not list continuation.
    const view = mount("- ```js", "- ```js".length);
    try {
      expect(pressEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- ```js\n  \n  ```");
    } finally {
      view.destroy();
    }
  });

  it("blockquote continuation is the deliberate upstream fallback (Quoll defers)", () => {
    // Quoll reimplements neither blockquote continuation nor Backspace markup
    // deletion, so upstream stays mounted at Prec.high to own this caret.
    const view = mount("> a", "> a".length);
    try {
      expect(pressEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("> a\n> ");
    } finally {
      view.destroy();
    }
  });

  it("plain paragraph: no structural handler claims Enter → default newline", () => {
    const view = mount("plain", 3);
    try {
      expect(pressEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("pla\nin");
    } finally {
      view.destroy();
    }
  });
});
