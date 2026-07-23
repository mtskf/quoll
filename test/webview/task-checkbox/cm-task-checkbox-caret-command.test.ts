// @vitest-environment happy-dom
//
// A11Y-06: the keyboard toggle path for the task checkbox. The inline
// Decoration.replace widget is NOT Tab-reachable in the CM contenteditable
// (Chromium/VS Code skips it), so a caret command is the keyboard toggle. These
// tests pin that command directly (behaviour) plus the chord constant + keymap
// registration — the Mod-chord itself is NOT exercised via runScopeHandlers,
// which is platform-flaky under happy-dom (memory
// [[quoll-cm-keymap-test-runscopehandlers-platform-flaky]]).

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import {
  findTaskMarkerOnLine,
  quollTaskCheckboxKeymap,
  TASK_TOGGLE_KEY,
  toggleTaskCheckboxAtCaret,
} from "../../../src/webview/cm/task-checkbox/task-checkbox-command.js";

/** Mount a real EditorView with the markdown language, caret at `caret`, and a
 *  FULLY parsed syntax tree (ensureSyntaxTree forces the parse to the doc end so
 *  the tree walk in findTaskMarkerOnLine is deterministic under full-suite CPU
 *  load — cf. the fullTree helper rationale). Optionally read-only. */
function mountView(doc: string, caret: number, readOnly = false): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(caret),
    extensions: [
      markdown({ base: markdownLanguage }),
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
    ],
  });
  const view = new EditorView({ state, parent });
  ensureSyntaxTree(view.state, view.state.doc.length, 5_000);
  return view;
}

describe("findTaskMarkerOnLine", () => {
  it("resolves the marker `[` position for a content-bearing task line", () => {
    const view = mountView("- [ ] alpha", 8); // caret in the body
    try {
      expect(findTaskMarkerOnLine(view.state, 8)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("resolves a content-less bare `- [ ]` line", () => {
    const view = mountView("- [ ]", 0);
    try {
      expect(findTaskMarkerOnLine(view.state, 0)).toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("returns null on a non-task line", () => {
    const view = mountView("just a paragraph", 4);
    try {
      expect(findTaskMarkerOnLine(view.state, 4)).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("returns null on a plain (non-task) bullet line", () => {
    const view = mountView("- plain bullet", 5);
    try {
      expect(findTaskMarkerOnLine(view.state, 5)).toBeNull();
    } finally {
      view.destroy();
    }
  });

  it("targets the INNERMOST task when the caret is on a nested child line", () => {
    const doc = "- [ ] parent\n  - [ ] child";
    const childMarker = doc.indexOf("[", doc.indexOf("child") - 6); // the child's `[`
    const view = mountView(doc, doc.indexOf("child"));
    try {
      expect(findTaskMarkerOnLine(view.state, doc.indexOf("child"))).toBe(childMarker);
      // Sanity: not the parent marker (offset 2).
      expect(findTaskMarkerOnLine(view.state, doc.indexOf("child"))).not.toBe(2);
    } finally {
      view.destroy();
    }
  });

  it("returns null on a task's wrapped continuation line (marker is on the FIRST line only)", () => {
    // The on-line guard: the marker sits on line 1, so a caret on the wrapped
    // continuation line (line 2) resolves no marker even though it is still
    // inside the same Task node. Deliberate contract (docstring) — pinned here.
    const doc = "- [ ] alpha\n  continued body";
    const caret = doc.indexOf("continued") + 3;
    const view = mountView(doc, caret);
    try {
      expect(findTaskMarkerOnLine(view.state, caret)).toBeNull();
    } finally {
      view.destroy();
    }
  });
});

describe("toggleTaskCheckboxAtCaret", () => {
  it("toggles `[ ]` -> `[x]` when the caret is on the task line, returns true", () => {
    const view = mountView("- [ ] alpha", 8);
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x] alpha");
    } finally {
      view.destroy();
    }
  });

  it("toggles `[x]` -> `[ ]` (unchecking)", () => {
    const view = mountView("- [x] alpha", 8);
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it("toggles a content-less bare `- [ ]` line", () => {
    const view = mountView("- [ ]", 0);
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [x]");
    } finally {
      view.destroy();
    }
  });

  it("toggles only the caret's own line in a multi-task doc", () => {
    const doc = "- [ ] one\n- [ ] two";
    const view = mountView(doc, doc.indexOf("two"));
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(true);
      expect(view.state.doc.toString()).toBe("- [ ] one\n- [x] two");
    } finally {
      view.destroy();
    }
  });

  it("returns false and does not mutate on a non-task line", () => {
    const view = mountView("plain text", 3);
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("plain text");
    } finally {
      view.destroy();
    }
  });

  it("returns false and does not mutate in a read-only view", () => {
    const view = mountView("- [ ] alpha", 8, true);
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(false);
      expect(view.state.doc.toString()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it("is a no-op when the caret is on a task's continuation line, not the marker line", () => {
    const doc = "- [ ] alpha\n  continued body";
    const caret = doc.indexOf("continued") + 3;
    const view = mountView(doc, caret);
    try {
      expect(toggleTaskCheckboxAtCaret(view)).toBe(false);
      expect(view.state.doc.toString()).toBe(doc);
    } finally {
      view.destroy();
    }
  });
});

describe("TASK_TOGGLE_KEY / quollTaskCheckboxKeymap", () => {
  it("binds Mod-l (single source of truth)", () => {
    expect(TASK_TOGGLE_KEY).toBe("Mod-l");
  });

  it("registers the chord -> toggleTaskCheckboxAtCaret so the editor is wired", () => {
    // Registration confirmation only (NOT a key-dispatch test — that is
    // platform-flaky under happy-dom). Build a view with the keymap extension
    // and assert the keymap facet carries a binding for TASK_TOGGLE_KEY whose
    // run is the caret command.
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc: "- [ ] alpha",
        extensions: [markdown({ base: markdownLanguage }), quollTaskCheckboxKeymap()],
      }),
      parent,
    });
    try {
      const bindings = view.state.facet(keymap).flat();
      const binding = bindings.find((b) => b.key === TASK_TOGGLE_KEY);
      expect(binding).toBeDefined();
      expect(binding?.run).toBe(toggleTaskCheckboxAtCaret);
    } finally {
      view.destroy();
    }
  });
});

// Guard the keymap extension is actually the one wired above (import-only smoke
// so a rename of the export breaks this test, not just editor.ts).
describe("quollTaskCheckboxKeymap extension", () => {
  it("is a non-empty extension", () => {
    expect(quollTaskCheckboxKeymap()).toBeDefined();
  });
});
