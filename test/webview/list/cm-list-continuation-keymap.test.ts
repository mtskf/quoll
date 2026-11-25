// @vitest-environment happy-dom

import { defaultKeymap, history, undo } from "@codemirror/commands";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  continueListOnEnter,
  listContinuationKeymap,
} from "../../../src/webview/cm/list/list-continuation-keymap.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import { settledMount } from "../helpers/settled-view.js";

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
  return settledMount({ state, parent });
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

  it("splits a task mid-content: the tail flows into a fresh unchecked task", () => {
    // Caret past the checkbox, inside the task body (space-free so the split is
    // clean, mirroring the bullet mid-content case). Pins that `contentStart =
    // taskMarker.to` lets a body caret proceed and the `isTask` branch emits a
    // fresh `- [ ] ` for the split-off tail.
    const view = mount("- [x] helloworld", at(11)); // caret after "hello"
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x] hello\n- [ ] world");
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

describe("continueListOnEnter — ordered renumber", () => {
  it("renumbers a sequential run after the inserted item", () => {
    const view = caretAtEndOf(mount("1. a\n2. b", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n2. \n3. b");
    } finally {
      view.destroy();
    }
  });

  it("preserves user-typed number gaps (only bumps following siblings)", () => {
    const view = caretAtEndOf(mount("1. a\n5. b\n9. c", at(0)), 2);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n5. b\n6. \n10. c");
    } finally {
      view.destroy();
    }
  });

  it("does NOT bump a nested child run (different OrderedList)", () => {
    const view = caretAtEndOf(mount("1. a\n   1. x\n2. b", at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n2. \n   1. x\n3. b");
    } finally {
      view.destroy();
    }
  });

  it("renumbers across a lazy-continuation line (tree siblings, not a line scan)", () => {
    const view = caretAtEndOf(mount("1. a\n2. b\nlazy line\n3. c", at(0)), 2);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n2. b\n3. \nlazy line\n4. c");
    } finally {
      view.destroy();
    }
  });

  it("renumbers on a mid-content split of an ordered item", () => {
    // Caret in the MIDDLE of an ordered item's content: the split insert AND the
    // renumber diff compose in one ChangeSpec array. Pins that the renumber edits
    // stay original-document-relative (they sit past `head`) while the tail flows
    // onto the new item.
    const view = mount("1. helloworld\n2. b", at(8)); // caret after "hello"
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. hello\n2. world\n3. b");
      expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from + 3);
    } finally {
      view.destroy();
    }
  });

  it("is ONE undo step including the renumber", () => {
    const view = caretAtEndOf(mount("1. a\n2. b", at(0), { withHistory: true }), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n2. \n3. b");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("1. a\n2. b");
    } finally {
      view.destroy();
    }
  });
});

/** The marker text of the ListItem that structurally OWNS the ListItem whose
 *  content contains `needle` — i.e. the parent item a nested child hangs under,
 *  or null when the child's list sits directly under Document. */
function parentMarkerOf(view: EditorView, needle: string): string | null {
  const { state } = view;
  const tree = ensureSyntaxTree(state, state.doc.length, 5000);
  if (tree === null) {
    throw new Error("parse did not reach EOF");
  }
  const node = tree.resolveInner(state.doc.toString().indexOf(needle), 1);
  let seenOwn = false;
  for (let n: typeof node | null = node; n !== null; n = n.parent) {
    if (n.name !== "ListItem") {
      continue;
    }
    if (!seenOwn) {
      seenOwn = true;
      continue;
    }
    const mark = n.getChild("ListMark");
    return mark === null ? null : state.doc.sliceString(mark.from, mark.to);
  }
  return null;
}

describe("continueListOnEnter — split keeps the item's children nested", () => {
  const cases: { name: string; doc: string; caretAfter: string; out: string; parent: string }[] = [
    {
      name: "9 → 10 (marker widens by one column)",
      doc: "9. abcd\n   - child",
      caretAfter: "9. ab",
      out: "9. ab\n10. cd\n    - child",
      parent: "10.",
    },
    {
      name: "99 → 100",
      doc: "99. abcd\n    - child",
      caretAfter: "99. ab",
      out: "99. ab\n100. cd\n     - child",
      parent: "100.",
    },
    {
      // A leading tab alone would open indented code, so nest under a bullet
      // (blank-separated: `9.` cannot interrupt a paragraph). The shift must land
      // after the tab — a space prepended before it is absorbed by the tab stop.
      name: "tab-indented item and child",
      doc: "- p\n\n\t9. abcd\n\t   - child",
      caretAfter: "9. ab",
      out: "- p\n\n\t9. ab\n\t10. cd\n\t    - child",
      parent: "10.",
    },
    {
      name: "tab after the marker (content column unchanged)",
      doc: "9.\tabcd\n\t- child",
      caretAfter: "9.\tab",
      out: "9.\tab\n10. cd\n\t- child",
      parent: "10.",
    },
    {
      name: "tab after a bullet marker",
      doc: "-\tabcd\n\t- child",
      caretAfter: "-\tab",
      out: "-\tab\n- cd\n  - child",
      parent: "-",
    },
    {
      name: "tab after a single-digit ordered marker",
      doc: "1.\tabcd\n\t- child",
      caretAfter: "1.\tab",
      out: "1.\tab\n2. cd\n   - child",
      parent: "2.",
    },
    {
      name: "extra spaces after the marker (new item uses one space)",
      doc: "9.   abcd\n     - child",
      caretAfter: "9.   ab",
      out: "9.   ab\n10. cd\n    - child",
      parent: "10.",
    },
    {
      name: "tab and space before a child under an aligned ordered marker",
      doc: "9.   abcd\n\t - child",
      caretAfter: "9.   ab",
      out: "9.   ab\n10. cd\n\t- child",
      parent: "10.",
    },
    {
      name: "bullet with extra spaces after the marker",
      doc: "-   abcd\n    - child",
      caretAfter: "-   ab",
      out: "-   ab\n- cd\n  - child",
      parent: "-",
    },
    {
      name: "space in the split tail adds marker padding",
      doc: "-   ab cd\n    - child",
      caretAfter: "-   ab",
      out: "-   ab\n-  cd\n   - child",
      parent: "-",
    },
    {
      name: "paragraph continuation line follows the split tail",
      doc: "9. abcd\n   more\n   - child",
      caretAfter: "9. ab",
      out: "9. ab\n10. cd\n    more\n    - child",
      parent: "10.",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: child stays under the new item, one undo restores`, () => {
      const view = mount(c.doc, at(c.doc.indexOf(c.caretAfter) + c.caretAfter.length), {
        withHistory: true,
      });
      try {
        expect(parentMarkerOf(view, "child")).not.toBeNull();
        expect(continueListOnEnter(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(c.out);
        expect(parentMarkerOf(view, "child")).toBe(c.parent);
        expect(undo(view)).toBe(true);
        expect(view.state.doc.toString()).toBe(c.doc);
      } finally {
        view.destroy();
      }
    });
  }

  it("does not shift a lazy-continuation line (not structurally the item's)", () => {
    const view = mount("9. abcd\nlazy", at(5));
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("9. ab\n10. cd\nlazy");
    } finally {
      view.destroy();
    }
  });

  it("shifts the widened sibling's children alongside the split's (both corrections compose)", () => {
    const doc = "8. abcd\n   - x\n9. e\n   - y";
    const view = mount(doc, at(5));
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("8. ab\n9. cd\n   - x\n10. e\n    - y");
      expect(parentMarkerOf(view, "x")).toBe("9.");
      expect(parentMarkerOf(view, "y")).toBe("10.");
    } finally {
      view.destroy();
    }
  });

  it("keeps the child nested when a tab absorbs the sibling's marker widening", () => {
    const doc = "1. abcd\n9.\txyz\n\n\t   - child";
    const view = mount(doc, at("1. ab".length), { withHistory: true });
    try {
      expect(parentMarkerOf(view, "child")).toBe("9.");
      expect(continueListOnEnter(view)).toBe(true);
      expect(parentMarkerOf(view, "child")).toBe("10.");
      expect(view.state.doc.toString()).toBe("1. ab\n2. cd\n10.\txyz\n\n\t   - child");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("keeps both lines in the indented code block when renumbering a same-width marker", () => {
    const doc = "1. abcd\n2.     first\n       second";
    const view = mount(doc, at("1. ab".length), { withHistory: true });
    try {
      expect(continueListOnEnter(view)).toBe(true);
      const { state } = view;
      const output = state.doc.toString();
      expect(output).toBe("1. ab\n2. cd\n3.     first\n       second");
      const tree = ensureSyntaxTree(state, state.doc.length, 5000);
      let block = tree?.resolveInner(output.indexOf("second"), 1);
      while (block && block.name !== "CodeBlock") {
        block = block.parent ?? undefined;
      }
      expect(block && state.doc.sliceString(block.from, block.to)).toBe("first\n       second");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("keeps a child nested when a tab just past the boundary would widen", () => {
    const doc = "9. abcd\n\n   \t- child";
    const view = mount(doc, at("9. ab".length), { withHistory: true });
    try {
      expect(parentMarkerOf(view, "child")).toBe("9.");
      expect(continueListOnEnter(view)).toBe(true);
      expect(parentMarkerOf(view, "child")).toBe("10.");
      expect(view.state.doc.toString()).toBe("9. ab\n10. cd\n\n     - child");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("preserves the tab inside fenced code when the split marker widens", () => {
    const doc = "9. abcd\n   ```\n   \treturn\n   ```";
    const view = mount(doc, at("9. ab".length), { withHistory: true });
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.line(4).text).toBe("    \treturn");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("preserves the payload tab in a Python fence", () => {
    const doc = "9. abcd\n   ```python\n   \treturn\n   ```";
    const view = mount(doc, at("9. ab".length), { withHistory: true });
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.line(4).text).toBe("    \treturn");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("keeps the grandchild under a nested marker followed by a tab", () => {
    const doc = "9. abcd\n      -\tx\n        - y";
    const view = mount(doc, at("9. ab".length), { withHistory: true });
    try {
      expect(parentMarkerOf(view, "y")).toBe("-");
      expect(continueListOnEnter(view)).toBe(true);
      expect(parentMarkerOf(view, "y")).toBe("-");
      expect(view.state.doc.toString()).toBe("9. ab\n10. cd\n       - x\n         - y");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("preserves the payload tab on an HTML block continuation", () => {
    const doc = "9. abcd\n\n   <pre>\n   \tvalue\n   </pre>";
    const view = mount(doc, at("9. ab".length), { withHistory: true });
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.line(5).text).toBe("    \tvalue");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("keeps HTML continuation lines inside the nested bullet", () => {
    const doc = "9. abcd\n      - <pre>\n    \tvalue\n        </pre>";
    const view = mount(doc, at("9. ab".length), { withHistory: true });
    try {
      expect(continueListOnEnter(view)).toBe(true);
      const { state } = view;
      const tree = ensureSyntaxTree(state, state.doc.length, 5000);
      const html = tree?.resolve(state.doc.toString().indexOf("value"), 1);
      expect(html?.name).toBe("HTMLBlock");
      expect(html?.parent?.name).toBe("ListItem");
      expect(html?.parent?.parent?.name).toBe("BulletList");
      expect(html?.to).toBe(state.doc.length);
      expect(state.doc.line(4).text).toBe("         value");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("keeps fenced code inside the nested bullet after a structural indent tab", () => {
    const doc = "9. abcd\n      - ```\n    \tvalue\n        ```";
    const view = mount(doc, at("9. ab".length), { withHistory: true });
    function codeText() {
      const { state } = view;
      const tree = ensureSyntaxTree(state, state.doc.length, 5000);
      expect(tree?.toString()).not.toContain("CodeBlock");
      const code = tree?.resolve(state.doc.toString().indexOf("value"), 1);
      expect(code?.name).toBe("CodeText");
      const fence = code?.parent;
      expect(fence?.name).toBe("FencedCode");
      expect(fence?.parent?.name).toBe("ListItem");
      expect(fence?.parent?.parent?.name).toBe("BulletList");
      expect(fence?.to).toBe(state.doc.length);
      return code && state.doc.sliceString(code.from, code.to);
    }
    try {
      const before = codeText();
      expect(before).toBe("value");
      expect(continueListOnEnter(view)).toBe(true);
      expect(codeText()).toBe(before);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("preserves CodeText after a quote padding tab", () => {
    const doc = "9. abcd\n   > ```python\n   >\t\treturn\n   > ```";
    const view = mount(doc, at("9. ab".length), { withHistory: true });
    function codeText() {
      const { state } = view;
      const tree = ensureSyntaxTree(state, state.doc.length, 5000);
      const code = tree?.resolve(state.doc.toString().indexOf("return"), 1);
      expect(code?.name).toBe("CodeText");
      return code && state.doc.sliceString(code.from, code.to);
    }
    try {
      const before = codeText();
      expect(before).toBe("\treturn");
      expect(continueListOnEnter(view)).toBe(true);
      expect(codeText()).toBe(before);
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });
});

describe("continueListOnEnter — empty marker line exits the list", () => {
  function expectExit(doc: string, caretLineNo: number, expected: string) {
    const view = caretAtEndOf(mount(doc, at(0)), caretLineNo);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(expected);
      expect(view.state.selection.main.head).toBe(view.state.doc.line(caretLineNo).from);
    } finally {
      view.destroy();
    }
  }

  it("exits a bare bullet `- `", () => {
    expectExit("- ", 1, "");
  });

  it("exits a bare ordered `1. `", () => {
    expectExit("1. ", 1, "");
  });

  it("exits a content-less task marker `- [ ]`", () => {
    expectExit("- [ ]", 1, "");
  });

  it("exits a trailing-space empty task `- [ ] ` (a Task node)", () => {
    expectExit("- [ ] ", 1, "");
  });

  it("exits an empty checked task `- [x] `", () => {
    expectExit("- [x] ", 1, "");
  });

  it("exits a nested empty item, blanking only its line", () => {
    expectExit("- a\n  - ", 2, "- a\n");
  });

  it("is ONE undo step — undo restores the marker", () => {
    const view = caretAtEndOf(mount("- ", at(0), { withHistory: true }), 1);
    try {
      expect(continueListOnEnter(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- ");
    } finally {
      view.destroy();
    }
  });
});

// A bare marker line whose item owns a body on the next lines is not an empty
// item: exiting would delete the marker and orphan the body. Enter continues the
// list from the marker-line end instead, through the WHOLE Enter stack — the
// upstream markdownKeymap Enter (insertNewlineContinueMarkup) deletes the marker
// line for these inputs, so Quoll must not fall through to it.
describe("continueListOnEnter — bare marker line that owns a body below", () => {
  function pressEnter(doc: string, caret: number, filler = ""): string {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    // A plain EditorView (not settledMount): with a large `filler` the initial
    // parse stops short of the caret, so listItemAt works on a tree cut at the
    // caret line — the partial-parse state the empty check must not trust.
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: filler + doc,
        extensions: [quollMarkdownLanguage(), listContinuationKeymap(), keymap.of(defaultKeymap)],
      }),
    });
    try {
      view.dispatch({ selection: EditorSelection.cursor(filler.length + caret) });
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
      return view.state.doc.sliceString(filler.length);
    } finally {
      view.destroy();
    }
  }

  it.each([
    ["- \n  body", 2, "- \n- \n  body"],
    ["1.\n   body", 2, "1.\n2. \n   body"],
    ["-\n  text", 1, "-\n- \n  text"],
    ["- a\n-\n  text", 5, "- a\n-\n- \n  text"],
    ["-\n  - child", 1, "-\n- \n  - child"],
    ["- a\n-\n  ```\n  code\n  ```", 5, "- a\n-\n- \n  ```\n  code\n  ```"],
  ])("Enter on %j continues the list", (doc, caret, expected) => {
    expect(pressEnter(doc, caret)).toBe(expected);
  });

  it("keeps the marker when the tree is parsed only up to the caret line", () => {
    const filler = "para line of some text here\n\n".repeat(1000);
    expect(pressEnter("-\n  text", 1, filler)).toBe("-\n- \n  text");
  });

  it.each([
    ["- ", 2, ""],
    ["-", 1, ""],
    ["- \n- b", 2, "\n- b"],
  ])("a truly empty item %j still exits the list", (doc, caret, expected) => {
    expect(pressEnter(doc, caret)).toBe(expected);
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

  it("a blockquote-prefixed list item (listItemAt probes `>`, resolves no ListItem)", () => {
    // Blockquoted lists are out of scope for both list keymaps: listItemAt probes
    // the line's first non-whitespace column (`>`), which resolves to the
    // Blockquote's QuoteMark, not a ListItem. The command defers to the default
    // Enter — a safe non-handling, never a corrupting edit.
    const doc = "> 1. a\n> 2. b";
    const view = caretAtEndOf(mount(doc, at(0)), 1);
    try {
      expect(continueListOnEnter(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
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
    const mod = await import("../../../src/webview/cm/list/list-continuation-keymap.js");
    expect(Object.keys(mod).sort()).toEqual(["continueListOnEnter", "listContinuationKeymap"]);
  });
});
