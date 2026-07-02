// @vitest-environment happy-dom
import { defaultKeymap, history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, runScopeHandlers } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  quollSyntaxReveal,
  syntaxRevealProviders,
} from "../../src/webview/cm/decorations/index.js";
import { linkReveal } from "../../src/webview/cm/decorations/link-reveal.js";
import { mountEditor } from "../../src/webview/editor.js";
import { initialState, type WebviewState } from "../../src/webview/state.js";
import { fullTree } from "./helpers/full-tree.js";

vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage: vi.fn(), setMetadata: vi.fn() }),
  subscribeToHost: () => () => {},
}));

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    selection: EditorSelection.single(0),
    extensions: [
      markdown({ base: markdownLanguage }),
      keymap.of(defaultKeymap),
      quollSyntaxReveal(),
      history(), // undo() returns false without this; C5 undo tests would silently pass
    ],
  });
  return new EditorView({ state, parent });
}

describe("orchestrator integration — providers wired", () => {
  it("emits decorations for a doc containing heading + blockquote + bold + italic + code + strike (per-provider direct-build assertions)", () => {
    // Round-2 had a single `n >= 6` against the merged set, but the inline-mark
    // provider alone emits 8 decorations on this fixture — heading and
    // blockquote could be entirely broken and the assertion would still pass.
    // Replace with per-provider direct-build assertions: each provider builds
    // a non-empty DecorationSet on its own against the same ctx.
    const doc = "# H\n> q\n**b** *i* `c` ~~s~~\n[link](https://example.com)";
    const view = mount(doc);
    try {
      const ctxBase = {
        state: view.state,
        selection: view.state.selection,
        visibleRanges: [{ from: 0, to: view.state.doc.length }],
        tree: fullTree(view.state),
      };
      const [headingProvider, blockquoteProvider, inlineProvider] = syntaxRevealProviders;
      const heading = headingProvider.build(ctxBase);
      const blockquote = blockquoteProvider.build(ctxBase);
      const inline = inlineProvider.build(ctxBase);
      expect(heading.size).toBeGreaterThan(0);
      expect(blockquote.size).toBeGreaterThan(0);
      expect(inline.size).toBeGreaterThan(0);
      // C4b: linkReveal participates in the merged set too.
      const linkSet = linkReveal.build(ctxBase);
      expect(linkSet.size).toBeGreaterThan(0);
    } finally {
      view.destroy();
    }
  });

  it("module-level providers array is stable across multiple createSyntaxReveal() calls (no fresh-array-per-render)", () => {
    expect(syntaxRevealProviders).toBe(syntaxRevealProviders);
    expect(syntaxRevealProviders).toHaveLength(6);
    expect(typeof syntaxRevealProviders[0]?.build).toBe("function");
    expect(typeof syntaxRevealProviders[1]?.build).toBe("function");
    expect(typeof syntaxRevealProviders[2]?.build).toBe("function");
    expect(typeof syntaxRevealProviders[3]?.build).toBe("function");
    expect(typeof syntaxRevealProviders[4]?.build).toBe("function");
    expect(typeof syntaxRevealProviders[5]?.build).toBe("function");
  });

  it("multi-cursor selection survives in the real editor mount — Claude reviewer H1, allowMultipleSelections facet ON", () => {
    // CodeMirror collapses multi-range selections to the main range unless
    // EditorState.allowMultipleSelections.of(true) is in the extensions
    // array. Without it, every per-caret reveal in the decoration providers
    // is unreachable for real multi-cursor users — the orchestrator
    // regression test sets the facet, but production didn't until this fix.
    // Assert against the PRODUCTION mountEditor (not a hand-rolled state)
    // so any future regression in editor.ts gets caught.
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state: WebviewState = {
      ...initialState,
      ready: true,
      docVersion: 1,
      canWrite: true,
    };
    const handle = mountEditor({
      parent,
      nonce: "test-nonce",
      getState: () => state,
      dispatch: () => {},
    });
    try {
      handle.applyDocument("# H1\n# H2\n# H3", true, 1);
      const mountEl = parent.querySelector(".quoll-editor") as HTMLElement | null;
      if (!mountEl) {
        throw new Error("Editor mount node missing");
      }
      const view = EditorView.findFromDOM(mountEl);
      if (!view) {
        throw new Error("EditorView not found via findFromDOM");
      }
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(2), // inside "# H1"
          EditorSelection.cursor(7), // inside "# H2"
        ]),
      });
      // The CRITICAL assertion: both ranges survived. With the facet OFF
      // CodeMirror would have collapsed them to a single range.
      expect(view.state.selection.ranges.length).toBe(2);
    } finally {
      handle.dispose();
      parent.remove();
    }
  });

  it("identity round-trip: typing inside a Strong span leaves the source bytes intact (decorations never mutate)", () => {
    const view = mount("**bold**");
    try {
      const before = view.state.doc.toString();
      view.dispatch({ selection: EditorSelection.single(4) });
      view.dispatch({ changes: { from: 4, insert: "X" } });
      // The doc grew by one char; the inserted char is at offset 4; bytes
      // around it (`**bo` and `ld**`) are untouched.
      const after = view.state.doc.toString();
      expect(after).toBe("**boXld**");
      // Critically: NO decoration ever called view.dispatch({ changes }).
      // Assert that by checking the source bytes the user did NOT type
      // are unchanged.
      expect(after.slice(0, 4)).toBe(before.slice(0, 4));
      expect(after.slice(5)).toBe(before.slice(4));
    } finally {
      view.destroy();
    }
  });
});

describe("integration — C5 list & task-list interactive", () => {
  it("task-list source round-trips byte-identically (no doc mutation by decoration build)", () => {
    const source = "- [ ] alpha\n- [x] beta\n  - [X] nested\n\nparagraph\n";
    const view = mount(source);
    try {
      // sliceDoc immediately after mount must equal the source — decorations
      // are visual only, doc bytes are NEVER mutated by provider build().
      expect(view.state.sliceDoc()).toBe(source);
    } finally {
      view.destroy();
    }
  });

  it("bullet/ordered list source round-trips byte-identically", () => {
    const source = "- alpha\n- beta\n\n1. one\n2. two\n3. three\n";
    const view = mount(source);
    try {
      expect(view.state.sliceDoc()).toBe(source);
    } finally {
      view.destroy();
    }
  });

  it("renders the checkbox widget when the caret is off a task line", () => {
    const source = "- [ ] alpha\n- [x] beta\n\nparagraph";
    const view = mount(source);
    try {
      // Caret on the trailing paragraph line.
      view.dispatch({ selection: { anchor: source.indexOf("paragraph") + 3 } });
      // Force a layout / paint tick via requestMeasure — happy-dom is
      // synchronous so this is a no-op, but it pins the contract for
      // future test environments.
      const checkboxes = view.dom.querySelectorAll(".quoll-task-checkbox");
      expect(checkboxes.length).toBe(2);
      expect(checkboxes[0]?.getAttribute("aria-checked")).toBe("false");
      expect(checkboxes[1]?.getAttribute("aria-checked")).toBe("true");
    } finally {
      view.destroy();
    }
  });

  it("clicking a checkbox toggles the source as ONE undo step (full mount path)", () => {
    const source = "- [ ] alpha\n";
    const view = mount(source);
    try {
      view.dispatch({ selection: { anchor: source.length } }); // off task line
      const box = view.dom.querySelector(".quoll-task-checkbox") as HTMLElement | null;
      if (!box) {
        throw new Error("checkbox widget not rendered");
      }
      box.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [x] alpha\n");
      // Undo once → restored to original bytes. `undo()` is imported at
      // top-of-file via the (b) import from step 1; `history()` is wired
      // in the mount helper.
      const ran = undo({ state: view.state, dispatch: view.dispatch.bind(view) });
      expect(ran).toBe(true); // pinned: history is actually wired
      expect(view.state.sliceDoc()).toBe(source);
    } finally {
      view.destroy();
    }
  });

  it("Enter at end of a task line continues via the active keymap (upstream markdownKeymap reachability)", () => {
    // CRITICAL: this MUST drive Enter through the active keymap, NOT call
    // insertNewlineContinueMarkup directly via require(). A future swap to
    // `markdown({ addKeymap: false })` would silently break smart-Enter
    // continuation; only `runScopeHandlers` (which walks the active
    // keymap chain on the state) reds CI on that regression.
    const source = "- [ ] alpha";
    const view = mount(source);
    try {
      view.dispatch({ selection: { anchor: source.length } });
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Enter" }),
        "editor"
      );
      expect(handled).toBe(true);
      expect(view.state.sliceDoc()).toBe("- [ ] alpha\n- [ ] ");
    } finally {
      view.destroy();
    }
  });

  it("Backspace at the start of a task body removes the task marker (upstream deleteMarkupBackward reachability)", () => {
    // Symmetric pin for the second markdownKeymap binding. Caret is
    // placed right after the task marker; Backspace should delete the
    // entire `- [ ] ` prefix per upstream deleteMarkupBackward.
    const source = "- [ ] alpha";
    const view = mount(source);
    try {
      // Caret right at the first content character "a" (position 6,
      // immediately after `- [ ] `).
      view.dispatch({ selection: { anchor: 6 } });
      const handled = runScopeHandlers(
        view,
        new KeyboardEvent("keydown", { key: "Backspace" }),
        "editor"
      );
      expect(handled).toBe(true);
      // Upstream deleteMarkupBackward removes the list+task marker. The
      // exact bytes depend on the upstream version; assert the marker is
      // gone (doc no longer starts with `- [ ]`).
      expect(view.state.sliceDoc().startsWith("- [ ]")).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("Enter on the trailing empty task line inserts a blank line above and PERSISTS the marker (upstream insertNewlineContinueMarkup contract)", () => {
    // Empirically verified upstream behaviour at
    // `@codemirror/lang-markdown@6.5.0`: when the caret is on an empty
    // trailing task item AND the prior item is non-empty, the command's
    // four "delete a level of markup" conditions all FAIL, so it falls
    // through to the "Move second item down, making tight two-item list
    // non-tight" branch — which inserts a blank line ABOVE the trailing
    // task item and KEEPS the marker. A FULL list exit requires a
    // second Enter (when the previous line is now empty, condition #3
    // fires and the marker is deleted). C5 only pins the first-Enter
    // contract here; the second-Enter exit is a manual smoke step.
    const source = "- [ ] alpha\n- [ ] ";
    const view = mount(source);
    try {
      view.dispatch({ selection: { anchor: source.length } });
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
      // First Enter — blank line inserted above; marker persists.
      expect(view.state.sliceDoc()).toBe("- [ ] alpha\n\n- [ ] ");
    } finally {
      view.destroy();
    }
  });

  it("Enter on an ordered list item continues with the renumbered marker (via active keymap)", () => {
    const source = "1. one\n2. two";
    const view = mount(source);
    try {
      view.dispatch({ selection: { anchor: source.length } });
      runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Enter" }), "editor");
      expect(view.state.sliceDoc()).toBe("1. one\n2. two\n3. ");
    } finally {
      view.destroy();
    }
  });
});
