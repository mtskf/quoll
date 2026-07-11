// @vitest-environment happy-dom

import { history, undo } from "@codemirror/commands";
import { forceParsing } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  continueListOnEnter,
  listContinuationKeymap,
} from "../../src/webview/cm/list/list-continuation-keymap.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";

function forceParse(view: EditorView): EditorView {
  // Force a full parse so the syntax tree is available synchronously in tests.
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
      // Matches the real editor (editor.ts) so the multi-cursor guard is exercised
      // — without this, CodeMirror collapses extra ranges to the main one.
      EditorState.allowMultipleSelections.of(true),
      EditorState.readOnly.of(opts.readOnly ?? false),
      ...(opts.withHistory ? [history()] : []),
      ...(opts.withKeymap ? [listContinuationKeymap()] : []),
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

/** Caret at the given absolute offset. */
function at(pos: number): SelectionRange {
  return EditorSelection.cursor(pos);
}

/** Caret at the END of 1-based line `n`, post-mount. */
function caretAtEndOf(view: EditorView, n: number): EditorView {
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(n).to) });
  return view;
}

describe("continueListOnEnter — marker continuation", () => {
  it("continues a `-` bullet, caret at the new marker end", () => {
    const view = caretAtEndOf(mount("- a", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- a\n- ");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).to);
    } finally {
      view.destroy();
    }
  });

  it("preserves the `*` bullet glyph", () => {
    const view = caretAtEndOf(mount("* a", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("* a\n* ");
    } finally {
      view.destroy();
    }
  });

  it("preserves the `+` bullet glyph", () => {
    const view = caretAtEndOf(mount("+ a", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("+ a\n+ ");
    } finally {
      view.destroy();
    }
  });

  it("increments an ordered `.` marker (no following siblings)", () => {
    const view = caretAtEndOf(mount("1. a", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n2. ");
    } finally {
      view.destroy();
    }
  });

  it("preserves the ordered `)` delimiter", () => {
    const view = caretAtEndOf(mount("1) a", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1) a\n2) ");
    } finally {
      view.destroy();
    }
  });

  it("continues a checked task as an unchecked `- [ ]`", () => {
    const view = caretAtEndOf(mount("- [x] done", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x] done\n- [ ] ");
    } finally {
      view.destroy();
    }
  });

  it("continues an unchecked task as an unchecked `- [ ]`", () => {
    const view = caretAtEndOf(mount("- [ ] buy milk", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] buy milk\n- [ ] ");
    } finally {
      view.destroy();
    }
  });

  it("keeps a nested item's indentation", () => {
    const view = caretAtEndOf(mount("- a\n  - b", at(0)), 2);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- a\n  - b\n  - ");
    } finally {
      view.destroy();
    }
  });

  it("splits mid-content: the text after the caret flows to the new item", () => {
    // "- helloworld", caret after "hello" (offset 7).
    const view = mount("- helloworld", at(7));
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- hello\n- world");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from + 2);
    } finally {
      view.destroy();
    }
  });
});

describe("continueListOnEnter — fall-through (returns false, doc unchanged)", () => {
  function expectNoop(doc: string, caret: number, opts?: { readOnly?: boolean }) {
    const view = mount(doc, at(caret), opts);
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  }

  it("plain paragraph", () => {
    expectNoop("just prose", 4);
  });

  it("inside a fenced code body", () => {
    const doc = "```\n- a\nmore";
    const view = mount(doc, at(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) }); // on "- a"
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("a fence opener on the marker line (`- ```` caret at line end)", () => {
    const doc = "- ```";
    const view = caretAtEndOf(mount(doc, at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("a blockquote-wrapped fence opener (`- > ``` ` caret at line end)", () => {
    const doc = "- > ```";
    const view = caretAtEndOf(mount(doc, at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("caret inside leading frontmatter YAML sequence line", () => {
    const doc = "---\ntags:\n  - x\n---\n";
    const view = mount(doc, at(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).to) }); // on "  - x"
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("caret before the content column (`1|. a`)", () => {
    expectNoop("1. a", 1); // between "1" and "."
  });

  it("caret inside a checkbox (`- [|x] a`)", () => {
    expectNoop("- [x] a", 3); // between "[" and "x"
  });

  it("read-only document", () => {
    expectNoop("- a", 3, { readOnly: true });
  });

  it("non-empty selection", () => {
    const view = mount("- a", EditorSelection.range(2, 3));
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("- a");
    } finally {
      view.destroy();
    }
  });

  it("multi-cursor selection", () => {
    const view = mount("- a\n- b", EditorSelection.create([at(3), at(7)]));
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("- a\n- b");
    } finally {
      view.destroy();
    }
  });

  it("a wrapped/loose body line (caret not on the marker line)", () => {
    // A loose list item with a body on a second line (blank-line-separated).
    const doc = "- a\n\n  b";
    const view = mount(doc, at(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(3).to) }); // on "  b"
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });
});

describe("continueListOnEnter — history + keymap wiring", () => {
  it("is ONE undo step — a single undo reverts the continuation", () => {
    const view = caretAtEndOf(mount("- a", at(0), { withHistory: true }), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- a\n- ");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- a");
    } finally {
      view.destroy();
    }
  });

  it("Enter via runScopeHandlers continues a list item (keymap wires Enter)", () => {
    const view = caretAtEndOf(mount("- a", at(0), { withKeymap: true }), 1);
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("- a\n- ");
    } finally {
      view.destroy();
    }
  });

  it("Enter via runScopeHandlers is NOT handled in a plain paragraph (falls through)", () => {
    const view = mount("plain", at(3), { withKeymap: true });
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
    const mod = await import("../../src/webview/cm/list/list-continuation-keymap.js");
    expect(Object.keys(mod).sort()).toEqual(["continueListOnEnter", "listContinuationKeymap"]);
  });
});
