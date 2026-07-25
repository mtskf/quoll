// @vitest-environment happy-dom
//
// Pins the effective Enter-handler precedence when Quoll's structural Enter
// keymaps are composed with the upstream `markdownKeymap` — the exact contest
// editor.ts sets up. quollMarkdownLanguage() mounts the upstream Enter
// (`insertNewlineContinueMarkup`) at Prec.high; the language is registered FIRST,
// so at equal precedence upstream shadowed Quoll's LIST continuation (equal-
// precedence keymaps resolve in registration order). listContinuationKeymap is
// therefore mounted at Prec.highest. fencedCodeEnterKeymap stays at Prec.high:
// upstream bails on any FencedCode ancestry so it never claims a fence opener,
// leaving nothing to shadow there.
//
// Effective order (highest→lowest): list continuation [highest] → upstream markup
// + fenced-code auto-close [both high] → CM default newline [default]. Each case
// below uses an input where Quoll and upstream produce DIFFERENT output, so it
// genuinely pins WHO handled the Enter (not a byte-identical no-op). This suite
// mirrors editor.ts's mount (same factories, same order) so it pins the real
// behaviour, not a reconstruction.

import { defaultKeymap } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
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
 *  Enter @ Prec.highest → Quoll fenced Enter @ Prec.high → CM default newline. */
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
    selection: EditorSelection.cursor(caret),
    extensions: [quollMarkdownLanguage()],
  });
  const view = new EditorView({ state, parent });
  forceParsing(view, view.state.doc.length, 5_000);
  continueListOnEnter(view);
  const out = view.state.doc.toString();
  view.destroy();
  return out;
}

describe("Enter precedence — Quoll list continuation vs upstream markdownKeymap", () => {
  it("plain list: Quoll's ordered renumber wins (upstream leaves a non-sequential run)", () => {
    // The load-bearing precedence pin. `1. a` + Enter on a run whose next item is
    // `5. b`: Quoll inserts `2. ` and renumbers the tail; upstream inserts `2. `
    // but leaves `5. b`. Asserting equality to Quoll's command-direct output proves
    // Quoll won; the not.toContain guard proves upstream did NOT (it would keep
    // "5. b"). Reverting listContinuationKeymap to Prec.high turns this red.
    const doc = "1. a\n5. b";
    const caret = 4; // end of "1. a"
    const view = mount(doc, caret);
    try {
      expect(pressEnter(view)).toBe(true);
      const dispatched = view.state.doc.toString();
      expect(dispatched).toBe(quollListDirect(doc, caret));
      expect(dispatched).not.toContain("5. b");
    } finally {
      view.destroy();
    }
  });

  it("blockquote inside a list item: Quoll defers, upstream continues the quote", () => {
    // `- > quote` + Enter. Quoll would split into a sibling bullet
    // (`- > quote\n- `, dropping the quote); it instead DEFERS (caretInBlockquote)
    // so upstream continues the quote within the item. The `  > ` continuation is
    // the fingerprint that upstream — not Quoll — handled it.
    const view = mount("- > quote", "- > quote".length);
    try {
      expect(pressEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- > quote\n  > ");
    } finally {
      view.destroy();
    }
  });

  it("list nested in a blockquote: upstream owns it, preserving the quote", () => {
    // `> - ` + Enter. The other nesting from the test above: a list INSIDE a quote.
    // Quoll never claims it (listItemAt's marker-column probe lands on the `>`
    // QuoteMark and returns null), so upstream removes the list marker and keeps the
    // blockquote (`> `). Contract pin for the "blockquote → upstream" boundary — the
    // caretInBlockquote guard also covers this direction as belt-and-suspenders.
    const view = mount("> - ", "> - ".length);
    try {
      expect(pressEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("> ");
    } finally {
      view.destroy();
    }
  });

  it("fenced-code opener: Quoll's auto-close wins over the default newline", () => {
    // Upstream never claims a fence opener (its context walk bails on FencedCode),
    // so this pins fenced-vs-default: fencedCodeEnterKeymap (Prec.high) beats the
    // default newline (Prec.default). A plain newline would yield "```js\n".
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
    // runs instead of a list continuation — pins the list→fence ordering. A list
    // continuation would have produced "- ```js\n- ".
    const view = mount("- ```js", "- ```js".length);
    try {
      expect(pressEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- ```js\n  \n  ```");
    } finally {
      view.destroy();
    }
  });

  it("top-level blockquote is the deliberate upstream fallback (Quoll defers)", () => {
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
