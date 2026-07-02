// @vitest-environment happy-dom

import { history, undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  autoCloseFenceOnEnter,
  fencedCodeEnterKeymap,
} from "../../src/webview/cm/decorations/fenced-code-enter-keymap.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";

function forceParse(view: EditorView): EditorView {
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

function mount(
  doc: string,
  selection: EditorSelection | SelectionRange,
  opts: { readOnly?: boolean; withHistory?: boolean; withKeymap?: boolean } = {}
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      quollMarkdownLanguage(),
      EditorState.readOnly.of(opts.readOnly ?? false),
      ...(opts.withHistory ? [history()] : []),
      ...(opts.withKeymap ? [fencedCodeEnterKeymap()] : []),
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

/** Cursor at the END of 1-based line `n`. */
function endOfLine(view: EditorView, n: number): SelectionRange {
  return EditorSelection.cursor(view.state.doc.line(n).to);
}

/** Move the caret to the end of 1-based line `n` (post-mount, once the doc is
 *  known). Returns the view for chaining. */
function caretAtEndOf(view: EditorView, n: number): EditorView {
  view.dispatch({ selection: endOfLine(view, n) });
  return view;
}

describe("autoCloseFenceOnEnter — trigger cases", () => {
  it("closes a lone ``` opener at EOF (empty body, caret between the fences)", () => {
    const view = caretAtEndOf(mount("```", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```\n\n```");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
      expect(view.state.doc.line(2).text).toBe("");
    } finally {
      view.destroy();
    }
  });

  it("closes an opener above content — the rest is NOT swallowed into the block", () => {
    const view = caretAtEndOf(mount("```\nhello\nworld", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```\n\n```\nhello\nworld");
      // "hello"/"world" are now OUTSIDE the fenced block (line 3 is the closer).
      expect(view.state.doc.line(3).text).toBe("```");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
    } finally {
      view.destroy();
    }
  });

  it("keeps the language tag on the opener and closes with a BARE fence", () => {
    const view = caretAtEndOf(mount("```ruby\nputs 1", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```ruby\n\n```\nputs 1");
      expect(view.state.doc.line(1).text).toBe("```ruby");
      expect(view.state.doc.line(3).text).toBe("```");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from);
    } finally {
      view.destroy();
    }
  });

  it("matches the opener's fence LENGTH (4 backticks → 4-backtick closer)", () => {
    const view = caretAtEndOf(mount("````\ntext", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("````\n\n````\ntext");
    } finally {
      view.destroy();
    }
  });

  it("closes a blockquote-prefixed fence with a matching `> ` closer", () => {
    const view = caretAtEndOf(mount("> ```ruby\n> body", EditorSelection.cursor(0)), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("> ```ruby\n> \n> ```\n> body");
      expect(view.state.doc.line(3).text).toBe("> ```");
      // Caret at end of the "> " body line (after the prefix).
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).to);
    } finally {
      view.destroy();
    }
  });

  it("closes a list-indented fence at the content column (no new list item)", () => {
    // A fence indented under a list item (leading spaces = content column).
    const view = caretAtEndOf(mount("- item\n  ```\n  code", EditorSelection.cursor(0)), 2);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- item\n  ```\n  \n  ```\n  code");
      expect(view.state.doc.line(4).text).toBe("  ```");
    } finally {
      view.destroy();
    }
  });

  it("triggers with the caret at the START of the opener line (not just at line end)", () => {
    // Caret at column 0 — before the fence run. resolving at the caret head would
    // land in Document (not FencedCode); the command probes the line END instead.
    const view = mount("```ruby\nputs 1", EditorSelection.cursor(0));
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```ruby\n\n```\nputs 1");
    } finally {
      view.destroy();
    }
  });
});

describe("autoCloseFenceOnEnter — non-trigger guards (return false, doc unchanged)", () => {
  it("does NOT trigger for inline `` `code` `` (no FencedCode ancestor)", () => {
    const doc = "a `code` b";
    const view = mount(doc, EditorSelection.cursor(4)); // inside the inline code
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT trigger from inside the block BODY of an unclosed fence", () => {
    const doc = "```\nbody\nmore";
    const view = mount(doc, EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) }); // on "body"
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT trigger on an ALREADY-CLOSED opener (a closer already follows)", () => {
    const doc = "```\ncode\n```";
    const view = caretAtEndOf(mount(doc, EditorSelection.cursor(0)), 1); // on the opener line
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT trigger in a plain paragraph", () => {
    const doc = "just prose";
    const view = mount(doc, EditorSelection.cursor(4));
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("does NOT trigger on a read-only doc", () => {
    const view = caretAtEndOf(mount("```", EditorSelection.cursor(0), { readOnly: true }), 1);
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("```");
    } finally {
      view.destroy();
    }
  });
});

describe("autoCloseFenceOnEnter — history + keymap wiring", () => {
  it("is ONE undo step — a single undo reverts the whole auto-close", () => {
    const view = caretAtEndOf(
      mount("```\nhello", EditorSelection.cursor(0), { withHistory: true }),
      1
    );
    try {
      expect(autoCloseFenceOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```\n\n```\nhello");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("```\nhello");
    } finally {
      view.destroy();
    }
  });

  it("Enter via runScopeHandlers auto-closes an opener (keymap wires Enter → command)", () => {
    const view = caretAtEndOf(
      mount("```\nhello", EditorSelection.cursor(0), { withKeymap: true }),
      1
    );
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("```\n\n```\nhello");
    } finally {
      view.destroy();
    }
  });

  it("Enter via runScopeHandlers is NOT handled in a plain paragraph (falls through)", () => {
    const view = mount("plain", EditorSelection.cursor(3), { withKeymap: true });
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(false);
      expect(view.state.doc.toString()).toBe("plain");
    } finally {
      view.destroy();
    }
  });

  it("exports exactly the command + the keymap factory", async () => {
    const mod = await import("../../src/webview/cm/decorations/fenced-code-enter-keymap.js");
    expect(Object.keys(mod).sort()).toEqual(["autoCloseFenceOnEnter", "fencedCodeEnterKeymap"]);
  });
});
