// @vitest-environment happy-dom

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, type syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  destinationForIndent,
  destinationForOutdent,
  enclosingListItem,
  followingListItems,
  isListNode,
  lastListItemOf,
  listItemAt,
} from "../../../src/webview/cm/list/list-tree.js";

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

// Resolves the `ListItem` enclosing line `n`'s first non-whitespace column —
// same probe strategy as list-tree.ts's listItemAt / the test-only duplicate
// in cm-list-transform.test.ts, reused here via the real listItemAt export.
function resolveItemAtLine(
  state: EditorState,
  n: number
): ReturnType<typeof syntaxTree>["topNode"] {
  const line = state.doc.line(n);
  const wsLen = line.text.length - line.text.trimStart().length;
  const item = listItemAt(state, line.from + wsLen);
  if (item === null) {
    throw new Error(`no ListItem found at line ${n}`);
  }
  return item;
}

describe("isListNode", () => {
  it("is true for OrderedList and BulletList, false otherwise", () => {
    const view = mount("1. a\n2. b\n- c", EditorSelection.cursor(0));
    try {
      const b = resolveItemAtLine(view.state, 3); // "- c"
      const ordered = resolveItemAtLine(view.state, 1).parent; // OrderedList
      const bullet = b.parent; // BulletList
      expect(ordered && isListNode(ordered)).toBe(true);
      expect(bullet && isListNode(bullet)).toBe(true);
      expect(isListNode(b)).toBe(false); // ListItem itself is not a list node
    } finally {
      view.destroy();
    }
  });
});

describe("enclosingListItem", () => {
  it("resolves a nested item's parent item", () => {
    const view = mount("- a\n  - child", EditorSelection.cursor(0));
    try {
      const child = resolveItemAtLine(view.state, 2); // "  - child"
      const parent = enclosingListItem(child);
      expect(parent && view.state.doc.sliceString(parent.from, parent.to)).toBe("- a\n  - child");
    } finally {
      view.destroy();
    }
  });

  it("returns null for a top-level item", () => {
    const view = mount("- A\n- B\n- C", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      expect(enclosingListItem(a)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});

describe("lastListItemOf / followingListItems", () => {
  it("lastListItemOf returns the final sibling ListItem in a list", () => {
    const view = mount("- A\n- B\n- C", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      const list = a.parent;
      const last = list && lastListItemOf(list);
      expect(last && view.state.doc.sliceString(last.from, last.to)).toBe("- C");
    } finally {
      view.destroy();
    }
  });

  it("followingListItems walks Lezer siblings after the item", () => {
    const view = mount("- A\n- B\n- C", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      const following = followingListItems(a);
      expect(following.map((n) => view.state.doc.sliceString(n.from, n.to))).toEqual([
        "- B",
        "- C",
      ]);
    } finally {
      view.destroy();
    }
  });

  it("followingListItems is empty for the last item", () => {
    const view = mount("- A\n- B\n- C", EditorSelection.cursor(0));
    try {
      const c = resolveItemAtLine(view.state, 3);
      expect(followingListItems(c)).toEqual([]);
    } finally {
      view.destroy();
    }
  });
});

describe("destinationForIndent", () => {
  it("resolves the preceding sibling within the same list", () => {
    const view = mount("- A\n- B\n- C", EditorSelection.cursor(0));
    try {
      const b = resolveItemAtLine(view.state, 2);
      const dest = destinationForIndent(b);
      expect(dest && view.state.doc.sliceString(dest.from, dest.to)).toBe("- A");
    } finally {
      view.destroy();
    }
  });

  it("resolves a preceding ordered item across adjacent lists", () => {
    const view = mount("1. a\n2. b\n- c", EditorSelection.cursor(0));
    try {
      const c = resolveItemAtLine(view.state, 3); // "- c" (separate BulletList)
      const dest = destinationForIndent(c);
      expect(dest && view.state.doc.sliceString(dest.from, dest.to)).toBe("2. b");
    } finally {
      view.destroy();
    }
  });

  it("returns null for the very first item (no preceding list either)", () => {
    const view = mount("- A\n- B\n- C", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      expect(destinationForIndent(a)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});

describe("destinationForOutdent", () => {
  it("resolves to the enclosing parent item", () => {
    const view = mount("- a\n  - child", EditorSelection.cursor(0));
    try {
      const child = resolveItemAtLine(view.state, 2);
      const dest = destinationForOutdent(child);
      expect(dest && view.state.doc.sliceString(dest.from, dest.to)).toBe("- a\n  - child");
    } finally {
      view.destroy();
    }
  });

  it("returns null for a top-level item", () => {
    const view = mount("- A\n- B", EditorSelection.cursor(0));
    try {
      const a = resolveItemAtLine(view.state, 1);
      expect(destinationForOutdent(a)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});
