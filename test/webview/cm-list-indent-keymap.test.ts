// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  indentListItem,
  listIndentKeymap,
  outdentListItem,
} from "../../src/webview/cm/decorations/list-indent-keymap.js";

function forceParse(view: EditorView): EditorView {
  forceParsing(view, view.state.doc.length, 5_000);
  return view;
}

function mount(
  doc: string,
  selection: EditorSelection | SelectionRange,
  opts: { readOnly?: boolean } = {}
): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection,
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.readOnly.of(opts.readOnly ?? false),
    ],
  });
  return forceParse(new EditorView({ state, parent }));
}

function at(view: EditorView, n: number, col = 0): EditorSelection | SelectionRange {
  const line = view.state.doc.line(n);
  return EditorSelection.cursor(Math.min(line.from + col, line.to));
}

// Number of `ListItem` ancestors of line `n`'s first non-whitespace position —
// the item's nesting depth. Re-parses first (the command's dispatch changed the
// doc). Pins ACTUAL structural nesting, not just the whitespace (Codex #2).
function itemDepth(view: EditorView, n: number): number {
  forceParsing(view, view.state.doc.length, 5_000);
  const line = view.state.doc.line(n);
  const wsLen = line.text.length - line.text.trimStart().length;
  let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(view.state).resolveInner(
    line.from + wsLen,
    1
  );
  let depth = 0;
  while (node !== null) {
    if (node.name === "ListItem") {
      depth++;
    }
    node = node.parent;
  }
  return depth;
}

describe("indentListItem", () => {
  it("nests a bullet under its preceding sibling (2-space marker) — depth 1→2", () => {
    const view = mount("- A\n- B\n- C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(itemDepth(view, 2)).toBe(1); // B starts top-level
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n  - B\n- C");
      expect(itemDepth(view, 2)).toBe(2); // B is now nested under A
    } finally {
      view.destroy();
    }
  });

  it("nests an ordered item by the marker width (3 spaces, NOT 2) — actually nests", () => {
    const view = mount("1. A\n2. B\n3. C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 3) });
    try {
      expect(indentListItem(view)).toBe(true);
      // 3 spaces — the ONLY indent that parses as nested under "1. A".
      expect(view.state.doc.toString()).toBe("1. A\n   2. B\n3. C");
      expect(itemDepth(view, 2)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("nests a GFM task-list item under its preceding task sibling", () => {
    const view = mount("- [ ] A\n- [ ] B", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 6) });
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] A\n  - [ ] B");
      expect(itemDepth(view, 2)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("carries nested children along (uniform subtree shift)", () => {
    const view = mount("- A\n- B\n  - C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n  - B\n    - C");
      expect(itemDepth(view, 2)).toBe(2); // B nested under A
      expect(itemDepth(view, 3)).toBe(3); // C still one deeper than B
    } finally {
      view.destroy();
    }
  });

  it("nests when the caret is at END of the item line (side-forward misresolve guard)", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).to) });
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n  - B");
    } finally {
      view.destroy();
    }
  });

  it("skips a whitespace-only interior line of a loose item", () => {
    const view = mount("- A\n- B\n   \n  more", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.line(2).text).toBe("  - B");
      expect(view.state.doc.line(3).text).toBe("   "); // untouched
      expect(view.state.doc.line(4).text).toBe("    more");
    } finally {
      view.destroy();
    }
  });

  it("is a no-op (returns true) on the FIRST item — nothing to nest under", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 1, 2) });
    try {
      expect(indentListItem(view)).toBe(true); // swallowed, no focus escape
      expect(view.state.doc.toString()).toBe("- A\n- B"); // unchanged
    } finally {
      view.destroy();
    }
  });

  it("is a no-op (returns true) in a plain paragraph — swallowed, focus does not escape", () => {
    const view = mount("just a paragraph", EditorSelection.cursor(4));
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("just a paragraph");
    } finally {
      view.destroy();
    }
  });

  it("is a no-op (returns true) inside a fenced code block, even nested in a list", () => {
    const doc = "- A\n  ```\n  code\n  ```";
    const view = mount(doc, EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from) }); // leading spaces of fence
    try {
      expect(indentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });

  it("returns false on a read-only doc (view-mode focus nav)", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0), { readOnly: true });
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(indentListItem(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("- A\n- B");
    } finally {
      view.destroy();
    }
  });
});

describe("outdentListItem", () => {
  it("promotes a nested bullet to its parent's level — depth 2→1", () => {
    const view = mount("- A\n  - B", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 4) });
    try {
      expect(itemDepth(view, 2)).toBe(2);
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n- B");
      expect(itemDepth(view, 2)).toBe(1);
    } finally {
      view.destroy();
    }
  });

  it("carries deeper children along on outdent", () => {
    const view = mount("- A\n  - B\n    - C", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 4) });
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n- B\n  - C");
      expect(itemDepth(view, 2)).toBe(1);
      expect(itemDepth(view, 3)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("is a no-op (returns true) on a top-level item — nothing to promote to", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: at(view, 2, 2) });
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n- B");
    } finally {
      view.destroy();
    }
  });

  it("returns true (swallow) in a plain paragraph", () => {
    const view = mount("paragraph", EditorSelection.cursor(3));
    try {
      expect(outdentListItem(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("paragraph");
    } finally {
      view.destroy();
    }
  });
});

describe("listIndentKeymap — registration + precedence", () => {
  function mountWithKeymap(doc: string, selection: EditorSelection | SelectionRange): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      selection,
      extensions: [markdown({ base: markdownLanguage }), listIndentKeymap()],
    });
    return forceParse(new EditorView({ state, parent }));
  }

  it("Tab via runScopeHandlers nests the item (keymap wires Tab → indentListItem)", () => {
    const view = mountWithKeymap("- A\n- B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from + 2) });
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n  - B");
    } finally {
      view.destroy();
    }
  });

  it("Shift-Tab via runScopeHandlers outdents the item", () => {
    const view = mountWithKeymap("- A\n  - B", EditorSelection.cursor(0));
    view.dispatch({ selection: EditorSelection.cursor(view.state.doc.line(2).from + 4) });
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", {
          key: "Tab",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("- A\n- B");
    } finally {
      view.destroy();
    }
  });

  it("Tab in a plain paragraph is swallowed (handled=true, doc unchanged) — no focus escape", () => {
    const view = mountWithKeymap("plain text", EditorSelection.cursor(3));
    try {
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.doc.toString()).toBe("plain text");
    } finally {
      view.destroy();
    }
  });

  it("exports exactly the two commands + the keymap factory", async () => {
    const mod = await import("../../src/webview/cm/decorations/list-indent-keymap.js");
    expect(Object.keys(mod).sort()).toEqual(
      ["indentListItem", "listIndentKeymap", "outdentListItem"].sort()
    );
  });
});
