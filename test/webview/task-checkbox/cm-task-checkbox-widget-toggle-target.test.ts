// @vitest-environment happy-dom

import { history } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { CheckboxWidget } from "../../../src/webview/cm/task-checkbox/task-checkbox-widget.js";

describe("CheckboxWidget — toggle dispatch (focus + toggle-target)", () => {
  function mountWithDoc(doc: string): EditorView {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), history()],
    });
    return new EditorView({ state, parent });
  }

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

  it("Space/Enter returns focus to the editor even when the toggle ABORTS (stale-from failure path)", () => {
    // Reproduce-first (round-cycle of PR #61): the keydown handler used to
    // call view.focus() ONLY inside `if (ok)`. On any of toggleTaskCheckbox's
    // five false-returning paths (stale-from guards + catch-and-log), Space /
    // Enter has already preventDefault'd, so focus stayed stranded on the
    // about-to-be-stale <span> and the user's next keystroke went nowhere.
    // Focus MUST return to the editor regardless of the toggle outcome.
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      document.body.appendChild(el);
      el.focus(); // simulate SR-rotor / Tab placement
      // Reseed so the captured `from` no longer points at a TaskMarker —
      // toggleTaskCheckbox now returns false (stale-from abort).
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "paragraph text" } });
      const focusSpy = vi.spyOn(view, "focus");
      el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      // The toggle aborted (doc unchanged) …
      expect(view.state.sliceDoc()).toBe("paragraph text");
      // … yet focus was still handed back to the editor.
      expect(focusSpy).toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("Space/Enter returns focus to the editor on a readOnly view (readOnly abort path)", () => {
    // Complements the stale-from failure-path test: the readOnly guard is the
    // most production-common abort, and it lives inside toggleTaskCheckbox
    // rather than the widget. Pin that the keydown handler returns focus to the
    // editor on this path too, so a future refactor that early-returns on
    // readOnly before view.focus() can't silently strand focus on read-only
    // documents.
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
      document.body.appendChild(el);
      el.focus();
      const focusSpy = vi.spyOn(view, "focus");
      el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      // Toggle aborted (readOnly guard) — doc unchanged …
      expect(view.state.sliceDoc()).toBe("- [ ] alpha");
      // … yet focus was still returned to the editor.
      expect(focusSpy).toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });

  it("Space keydown after view.destroy() does not throw (unconditional focus is dead-view safe)", () => {
    // The keydown focus now runs unconditionally, so a Space/Enter arriving
    // after tear-down would call view.focus() on a destroyed view. That must
    // stay as harmless as the mousedown destroyed-view case in
    // cm-task-checkbox-widget-toggle.test.ts.
    const view = mountWithDoc("- [ ] alpha");
    const w = new CheckboxWidget(false, 2, "alpha");
    const el = w.toDOM(view);
    document.body.appendChild(el);
    view.destroy();
    expect(() =>
      el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }))
    ).not.toThrow();
  });

  // The DOM is NOT an input to the toggle target. `data-from` is still
  // written (DOM inspection, plus the re-stamp assertions in
  // cm-task-checkbox-widget-toggle.test.ts), but the
  // listeners read the module-private `toggleTarget` WeakMap, so a value
  // written onto the span cannot steer the dispatch.
  //
  // Both rows pin the same "tampered dataset is ignored" contract via two
  // different tampered values reaching `toggleTaskCheckbox` under a
  // hypothetical `Number(span.dataset.from)` regression: "abc" → NaN, which
  // slips past the `markerFrom < 0 || markerFrom + 3 > doc.length` bounds
  // check (NaN comparisons are always false) and is instead caught by the
  // TASK_MARKER_RE slice check; "999" is caught earlier, by that same bounds
  // check, since 999 + 3 exceeds this 11-character doc's length. Either
  // tampered value would make the row go red (doc stays unchanged, failing
  // the "- [x] alpha" assertion) under that regression — the two rows exist
  // to cover both of `toggleTaskCheckbox`'s early guards, not because one
  // value would silently toggle unrelated bytes and the other wouldn't.
  it.each([
    ["malformed", "abc"],
    ["well-formed but wrong", "999"],
  ])("ignores a %s data-from written onto the widget span (mousedown)", (_label, raw) => {
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      el.dataset.from = raw;
      el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
      // Toggled at the REAL `from` (2), not the tampered dataset value.
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
    } finally {
      view.destroy();
    }
  });

  it.each([
    ["malformed", "abc"],
    ["well-formed but wrong", "999"],
  ])("ignores a %s data-from written onto the widget span (keydown)", (_label, raw) => {
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      document.body.appendChild(el);
      el.focus();
      el.dataset.from = raw;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
    } finally {
      view.destroy();
    }
  });

  // A fresh toDOM'd widget's mousedown must hit the `toggleTarget` entry
  // written in toDOM, not the resolveToggleFrom miss fallback — the absent
  // `console.error` is the only observable difference (both trace back to
  // the same `from` constructor argument, so the toggled bytes alone would
  // stay green even if `toggleTarget.set(span, this.from)` were deleted
  // from toDOM). Mirrors image-widget.ts's pin of the same gap.
  it("does not log a toggleTarget miss when a fresh toDOM'd widget is clicked", () => {
    const view = mountWithDoc("- [ ] alpha");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      view.destroy();
    }
  });

  it("logs the toggleTarget-miss breadcrumb and still dispatches at widget.from on a WeakMap miss", () => {
    const view = mountWithDoc("- [ ] alpha");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = new CheckboxWidget(false, 2, "alpha");
    const el = w.toDOM(view);
    // Force a genuine WeakMap miss on THIS widget's span, without reaching
    // into module-private state. `toDOM` already called `toggleTarget.set`,
    // so a blanket `mockReturnValueOnce(undefined)` on `WeakMap.prototype.get`
    // would risk being consumed by some unrelated WeakMap.get CodeMirror's
    // internals make first (e.g. during dispatchEvent) — silently making the
    // miss land on the wrong call and this test vacuous. Matching on key
    // identity instead (`key === el`) targets exactly this span's entry and
    // falls through to the real implementation for every other key,
    // reproducing exactly the "an entry SHOULD be there but isn't" invariant
    // violation this branch exists to catch.
    const originalGet = WeakMap.prototype.get;
    const getSpy = vi.spyOn(WeakMap.prototype, "get").mockImplementation(function (
      this: WeakMap<object, unknown>,
      key: object
    ) {
      if (key === el) {
        return undefined;
      }
      return originalGet.call(this, key);
    });
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
      // Still toggles — using the fallback (widget.from), not silently dropped.
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
      expect(errSpy).toHaveBeenCalledWith(
        "[quoll] task checkbox widget toggleTarget miss — invariant violated",
        { label: "alpha", checked: false, fallback: 2 }
      );
    } finally {
      getSpy.mockRestore();
      errSpy.mockRestore();
      view.destroy();
    }
  });

  it("toggleTarget-miss breadcrumb reports the MISSING widget's label, not another widget's (wrong-widget mix-up guard)", () => {
    // The single-checkbox miss test above only proves label: "alpha" is
    // reported when "alpha" is the only label in scope — it can't tell "the
    // breadcrumb reports the widget that actually missed" apart from "it
    // reports some other widget's label that happens to be the only value
    // available". Mount two checkboxes and force the miss on ONLY the
    // second widget's span so a wrong-widget mix-up (breadcrumb reporting
    // "alpha" while "beta" is the one that missed) would be observable.
    const view = mountWithDoc("- [ ] alpha\n- [ ] beta");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const wAlpha = new CheckboxWidget(false, 2, "alpha");
    const elAlpha = wAlpha.toDOM(view);
    // "- [ ] alpha\n" is 12 chars; beta's `[` sits at 12 + 2 = 14.
    const wBeta = new CheckboxWidget(false, 14, "beta");
    const elBeta = wBeta.toDOM(view);
    const originalGet = WeakMap.prototype.get;
    const getSpy = vi.spyOn(WeakMap.prototype, "get").mockImplementation(function (
      this: WeakMap<object, unknown>,
      key: object
    ) {
      if (key === elBeta) {
        return undefined;
      }
      return originalGet.call(this, key);
    });
    try {
      // alpha's own entry is untouched by the stub — this click must NOT miss.
      elAlpha.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true })
      );
      expect(errSpy).not.toHaveBeenCalled();
      expect(view.state.sliceDoc(3, 4)).toBe("x");

      // beta's entry is stubbed to miss — fallback dispatch at widget.from (14),
      // and the breadcrumb must report "beta", not "alpha".
      elBeta.dispatchEvent(
        new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true })
      );
      expect(view.state.sliceDoc(15, 16)).toBe("x");
      expect(errSpy).toHaveBeenCalledWith(
        "[quoll] task checkbox widget toggleTarget miss — invariant violated",
        { label: "beta", checked: false, fallback: 14 }
      );
    } finally {
      getSpy.mockRestore();
      errSpy.mockRestore();
      view.destroy();
    }
  });

  it("mousedown does NOT return focus to the editor (mouse users drive the next action)", () => {
    // Pin the deliberate asymmetry: only the keydown path calls view.focus().
    // Mousedown intentionally leaves focus alone (round-3 #23) — moving the
    // keydown focus out of `if (ok)` must not leak into the mouse path.
    const view = mountWithDoc("- [ ] alpha");
    try {
      const w = new CheckboxWidget(false, 2, "alpha");
      const el = w.toDOM(view);
      const focusSpy = vi.spyOn(view, "focus");
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(view.state.sliceDoc()).toBe("- [x] alpha");
      expect(focusSpy).not.toHaveBeenCalled();
    } finally {
      view.destroy();
    }
  });
});
