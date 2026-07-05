// @vitest-environment happy-dom

import { history, undo } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { CheckboxWidget } from "../../src/webview/cm/decorations/task-checkbox-widget.js";

function mountView(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  return new EditorView({ state, parent });
}

describe("CheckboxWidget — DOM + a11y", () => {
  it('renders <span role="checkbox"> with tabindex=0', () => {
    const view = mountView("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      expect(el.tagName).toBe("SPAN");
      expect(el.getAttribute("role")).toBe("checkbox");
      expect(el.getAttribute("tabindex")).toBe("0");
    } finally {
      view.destroy();
    }
  });

  it("aria-checked reflects checked state", () => {
    const view = mountView("- [x] alpha");
    try {
      const checked = new CheckboxWidget(true, 2, "alpha").toDOM(view);
      const unchecked = new CheckboxWidget(false, 2, "beta").toDOM(view);
      expect(checked.getAttribute("aria-checked")).toBe("true");
      expect(unchecked.getAttribute("aria-checked")).toBe("false");
    } finally {
      view.destroy();
    }
  });

  it("aria-label includes the trimmed task body", () => {
    const view = mountView("- [ ] Finish the report");
    try {
      const el = new CheckboxWidget(false, 2, "Finish the report").toDOM(view);
      expect(el.getAttribute("aria-label")).toContain("Finish the report");
    } finally {
      view.destroy();
    }
  });

  it("carries .quoll-task-checkbox class and data-checked attribute", () => {
    const view = mountView("- [ ] alpha");
    try {
      const el = new CheckboxWidget(true, 2, "alpha").toDOM(view);
      expect(el.classList.contains("quoll-task-checkbox")).toBe(true);
      expect(el.dataset.checked).toBe("true");
    } finally {
      view.destroy();
    }
  });

  it("eq() returns true when checked + from match (label deliberately excluded)", () => {
    const a = new CheckboxWidget(true, 5, "foo");
    const b = new CheckboxWidget(true, 5, "bar");
    expect(a.eq(b)).toBe(true);
  });

  it("eq() returns false when checked differs", () => {
    const a = new CheckboxWidget(false, 5, "foo");
    const b = new CheckboxWidget(true, 5, "foo");
    expect(a.eq(b)).toBe(false);
  });

  it("eq() returns false when from differs", () => {
    const a = new CheckboxWidget(true, 5, "foo");
    const b = new CheckboxWidget(true, 9, "foo");
    expect(a.eq(b)).toBe(false);
  });

  it("ignoreEvent returns true so CodeMirror does not consume widget events", () => {
    const a = new CheckboxWidget(false, 2, "alpha");
    // Synthetic event — widget should signal "I handle this myself"
    expect(a.ignoreEvent()).toBe(true);
  });
});

describe("CheckboxWidget — toggle dispatch", () => {
  function mountWithDoc(doc: string): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), history()],
    });
    return new EditorView({ state, parent });
  }

  it("mousedown on the widget dispatches a single 3-char-position replace at from+1", () => {
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      // ` ` → `x` at position 3 (`from + 1`)
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
      // event was consumed (caret would not move)
      expect(ev.defaultPrevented).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("mousedown toggles `[x]` → `[ ]`", () => {
    const view = mountWithDoc("- [x] alpha");
    try {
      const w = new CheckboxWidget(true, 2, "alpha");
      const el = w.toDOM(view);
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it("mousedown on `[X]` normalises to lowercase `[ ]` on toggle (case normalisation)", () => {
    const view = mountWithDoc("- [X] alpha");
    try {
      // The widget reports `checked: true` because Lezer parses [X] as the
      // checked variant; toggle writes ` ` over the X.
      const w = new CheckboxWidget(true, 2, "alpha");
      const el = w.toDOM(view);
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it("Space keydown on the focused widget toggles", () => {
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      document.body.appendChild(el); // ensure attached for focus
      el.focus();
      const ev = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
      expect(ev.defaultPrevented).toBe(true);
    } finally {
      view.destroy();
    }
  });

  it("Enter keydown on the focused widget toggles", () => {
    const view = mountWithDoc("- [x] alpha");
    try {
      const w = new CheckboxWidget(true, 2, "alpha");
      const el = w.toDOM(view);
      document.body.appendChild(el);
      el.focus();
      el.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })
      );
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it("other keydowns (e.g. 'a') do not toggle and do not preventDefault", () => {
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      const ev = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
      expect(ev.defaultPrevented).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("right-click (mousedown button !== 0) does not toggle", () => {
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      const ev = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it("toggle is one undo step — undo restores the pre-toggle bytes (history() in mount)", () => {
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
      // This single call MUST restore the original bytes — proves the
      // toggle was exactly one transaction. Without history() in mount,
      // undo returns false and the assertion would pass for the wrong
      // reason.
      const ran = undo({ state: view.state, dispatch: view.dispatch.bind(view) });
      expect(ran).toBe(true); // pinned: history is actually wired
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it('two rapid toggles produce TWO undo steps (isolateHistory.of("full"))', () => {
    // CodeMirror's history coalesces transactions sharing a userEvent
    // prefix within newGroupDelay (~500ms). Without isolateHistory each
    // rapid double-click would merge into one undo entry; the user's
    // mental model is "each click = one step". Pin the contract.
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w1 = new CheckboxWidget(false, 2, "alpha");
      const el1 = w1.toDOM(view);
      el1.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
      // Second click — a fresh widget instance because eq() flipped on
      // checked-state change (Task 2 contract).
      const w2 = new CheckboxWidget(true, 2, "alpha");
      const el2 = w2.toDOM(view);
      el2.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
      // First undo: reverts only the SECOND toggle.
      undo({ state: view.state, dispatch: view.dispatch.bind(view) });
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
      // Second undo: reverts the FIRST toggle.
      undo({ state: view.state, dispatch: view.dispatch.bind(view) });
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it("toggle silently aborts when the captured `from` no longer points at a TaskMarker (stale-from guard)", () => {
    // Simulate a host reseed shifting the doc: the widget's captured
    // `from` now points inside unrelated text. The toggle command MUST
    // re-validate the 3-byte slice and abort instead of writing a stray
    // character.
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      // Reseed: replace the whole doc with text that has NO TaskMarker
      // at position 2.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "paragraph text" } });
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      // The doc MUST be unchanged after the click — silent abort.
      expect(view.state.sliceDoc()).toBe("paragraph text");
    } finally {
      view.destroy();
    }
  });

  it("toggle does not throw when the view is destroyed (destroyed-view safety)", () => {
    // A widget DOM event arriving after view.destroy() must not surface
    // as an uncaught error in the console.
    const view = mountWithDoc("- [ ] alpha");
    const w = new CheckboxWidget(false, 2, "alpha");
    const el = w.toDOM(view);
    view.destroy();
    // No throw despite the dead view:
    expect(() =>
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }))
    ).not.toThrow();
  });

  it("toggle is a no-op when EditorState.readOnly is on (readOnly guard)", () => {
    // EditorState.readOnly blocks native input but NOT programmatic
    // dispatch. Without an explicit guard the widget would mutate the
    // doc even in a read-only buffer.
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc: "- [ ] alpha",
      extensions: [markdown({ base: markdownLanguage }), history(), EditorState.readOnly.of(true)],
    });
    const view = new EditorView({ state, parent });
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      // Source bytes unchanged — readOnly guard fired in toggleTaskCheckbox.
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
    } finally {
      view.destroy();
    }
  });

  it("Lezer cross-check rejects positions that are NOT a TaskMarker boundary (inline-code false-positive)", () => {
    // Regex on the 3-byte slice catches "marker bytes overwritten" but
    // PASSES whenever those bytes happen to literally spell `[ ]` (or
    // `[x]`). The syntaxTree cross-check is the structural guard: it
    // asserts the Lezer node at `markerFrom` is a `TaskMarker` that
    // STARTS exactly there.
    //
    // Construct a doc where bytes [9, 12) are literally "[ ]" but
    // belong to an inline-code span, NOT a TaskMarker:
    //   "literal `[ ]` in body" — backtick-quoted span carrying `[ ]`.
    //   l=0 i=1 t=2 e=3 r=4 a=5 l=6 ' '=7 `=8 [=9 ' '=10 ]=11 `=12 …
    // Regex on slice [9, 12) = "[ ]" PASSES. syntaxTree at pos 9
    // resolves to a CodeMark / InlineCode node, NOT a TaskMarker —
    // cross-check aborts.
    const view = mountWithDoc("literal `[ ]` in body");
    try {
      const w = new CheckboxWidget(false, 9, "literal");
      const el = w.toDOM(view);
      const before = view.state.sliceDoc();
      // Sanity: the regex WOULD have passed without the cross-check.
      expect(view.state.doc.sliceString(9, 12)).toBe("[ ]");
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe(before);
    } finally {
      view.destroy();
    }
  });

  it("updateDOM re-stamps `from` and toggles the NEW marker after a shift", () => {
    const view = mountWithDoc("- [ ] alpha\n- [ ] beta");
    try {
      // "alpha" marker `[` at 2; shift to the "beta" marker `[` at 14.
      const a = new CheckboxWidget(false, 2, "alpha");
      const el = a.toDOM(view);
      const reused = new CheckboxWidget(false, 14, "beta").updateDOM(el, view, a);

      expect(reused).toBe(true);
      expect(el.dataset.from).toBe("14");
      expect(el.getAttribute("aria-label")).toBe("Task: beta");

      // mousedown toggles the marker at the STAMPED from (14+1=15), not stale 2.
      el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc(15, 16)).toBe("x");
    } finally {
      view.destroy();
    }
  });

  it("updateDOM returns false (forcing a rebuild) on a checked-state change", () => {
    const view = mountWithDoc("- [ ] alpha");
    try {
      const a = new CheckboxWidget(false, 2, "alpha");
      const el = a.toDOM(view);
      expect(new CheckboxWidget(true, 2, "alpha").updateDOM(el, view, a)).toBe(false);
    } finally {
      view.destroy();
    }
  });

  it("Space/Enter on the focused widget returns focus to the editor after toggle (round-3 #23 — keyboard UX)", () => {
    // The keydown handler explicitly calls view.focus() after a
    // successful toggle so the keyboard user can keep typing without
    // a manual focus shift. Mousedown deliberately does NOT do this
    // (mouse users drive next actions via pointer; keeping focus on
    // a soon-to-be-destroyed widget DOM is theatrical anyway — round-3
    // #23 established the focus is nullified by the DOM swap on the
    // next provider rebuild).
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      document.body.appendChild(el);
      el.focus(); // simulate SR-rotor / Tab placement
      el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      // The contract is "view.focus() was called". We can't reliably
      // assert document.activeElement === view.contentDOM under
      // happy-dom (DOM swap timing) — but view.hasFocus correctly
      // reflects the view.focus() effect.
      expect(view.hasFocus).toBe(true);
    } finally {
      view.destroy();
    }
  });
});
