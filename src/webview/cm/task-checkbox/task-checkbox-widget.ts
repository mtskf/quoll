// Task-list checkbox widget rendered in place of a 3-char `[ ]` / `[x]` /
// `[X]` source range. The widget is interactive in two ways:
//   - mouse: mousedown toggles the marker (Task 3 wires the handler)
//   - keyboard: Space / Enter on the focused widget toggle (Task 3)
//
// a11y contract (Done-when for C5):
//   - role="checkbox" so screen readers announce as a checkbox
//   - aria-checked="true"/"false" reflects the source `x`/` ` state
//   - aria-label carries a short body label so the announcement is "Task:
//     Finish the report, unchecked" rather than just "checkbox, unchecked"
//   - tabindex=0 so the widget is in the screen-reader navigation rotor.
//     Empirically (C5 manual smoke, Chromium + VS Code webview) browser
//     Tab inside the editor's contenteditable does NOT move focus into
//     inline `Decoration.replace` widgets — so Space/Enter activation
//     here is for SR users who reach the widget via SR-specific
//     navigation, not via Tab. If a future browser/CM change makes Tab
//     enter widgets, revisit: the keydown handler still works, but the
//     Tab path becomes a fast-path that needs explicit a11y testing.
//     The Tab-independent keyboard toggle is the `Mod-l` caret command
//     (`toggleTaskCheckboxAtCaret`, task-checkbox-command.ts): with the
//     caret on the task line the widget is suppressed (source `[ ]` shows)
//     and that command toggles it, so keyboard-only users are not blocked
//     on reaching this widget (A11Y-06).
//
// eq() is keyed on (checked, from) only — body text changes don't force
// a re-render because the aria-label can stay slightly stale (it
// refreshes only when (checked, from) changes — i.e. on a toggle or on
// an edit that shifts the marker's byte offset; typing on the SAME
// line after the marker does NOT refresh it). Deliberate tradeoff:
// saves a widget re-render on every keystroke in the body at the cost
// of a transiently stale SR announcement. Revisit if a11y audit flags
// it.

import { type EditorView, WidgetType } from "@codemirror/view";

import { toggleTaskCheckbox } from "./task-checkbox-command.js";

// The marker's CURRENT `[` offset, keyed on the widget's root element.
//
// Keyed on the element rather than held in the `toDOM` closure because
// `updateDOM` reuses that element across widget instances: after a distant
// edit shifts this marker, CodeMirror builds a NEW widget, `eq()` returns
// false, and `updateDOM` re-points the reused DOM — but it cannot re-bind
// the mousedown/keydown listeners, whose captured `this` is the OLD
// instance. So the new instance needs a channel to hand the current offset
// to the existing listeners, and the channel has to be updatable exactly
// when the position moves, which `updateDOM` can do and a closure cannot.
// A WeakMap so a discarded span takes its entry with it. Same pattern, same
// reason, as image-widget.ts's `blockStart`.
//
// A WeakMap rather than the `dataset.from` stamp it replaced, so the offset
// stays a `number` end to end: nothing is stringified, parsed, or read back
// from the DOM, so there is no malformed-value state to validate against.
const toggleTarget = new WeakMap<HTMLElement, number>();

// Shared by the mousedown and keydown listeners in toDOM. Falling back to
// `widget.from` on a miss does not reintroduce the stale-closure hazard the
// WeakMap exists to fix: the entry is set in the same breath as attaching
// the listeners (toDOM) and re-set on every reuse (updateDOM), so a miss is
// unreachable by construction. Logged, not silently trusted, so a future
// regression of that invariant is observable instead of silently
// reintroducing a stale toggle target.
function resolveToggleFrom(span: HTMLElement, widget: CheckboxWidget): number {
  const from = toggleTarget.get(span);
  if (from === undefined) {
    console.error("[quoll] task checkbox widget toggleTarget miss — invariant violated", {
      label: widget.label,
      checked: widget.checked,
      fallback: widget.from,
    });
    return widget.from;
  }
  return from;
}

export class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    /** Doc position of the `[` opening bracket — the toggle target sits
     *  at `from + 1` (the middle char). */
    readonly from: number,
    /** Trimmed body text for the accessible name; not part of eq(). */
    readonly label: string
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof CheckboxWidget && other.checked === this.checked && other.from === this.from
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement("span");
    span.className = "quoll-task-checkbox";
    span.setAttribute("role", "checkbox");
    span.setAttribute("aria-checked", this.checked ? "true" : "false");
    span.setAttribute(
      "aria-label",
      this.label.length > 0 ? `Task: ${this.label}` : "Task list item"
    );
    span.tabIndex = 0;
    span.dataset.checked = this.checked ? "true" : "false";
    // `data-from` is written for DOM inspection (and read by tests that pin
    // the re-stamp) and is NEVER read back — see `toggleTarget` above for why
    // the toggle offset must not be parsed back out of the DOM.
    span.dataset.from = String(this.from);
    toggleTarget.set(span, this.from);

    span.addEventListener("mousedown", (event) => {
      // Left-click only — right/middle click stays as plain browser
      // events (context menu / paste).
      if (event.button !== 0) {
        return;
      }
      // preventDefault stops CodeMirror's selection-on-mousedown from
      // moving the caret into the (atomic) widget range. We intentionally
      // do NOT call span.focus() here — round-3 #23 established that any
      // focus on this span is destroyed by the post-dispatch widget
      // DOM swap (eq() returns false on checked-state change → CM
      // replaces the DOM → activeElement falls to <body>). Post-click
      // Space/Enter activation cannot be reliably delivered through
      // Decoration.replace widgets without orchestrator-level focus-
      // restoration plumbing; the promise has been withdrawn for C5.
      event.preventDefault();
      event.stopPropagation();
      toggleTaskCheckbox(view, resolveToggleFrom(span, this));
    });

    span.addEventListener("keydown", (event) => {
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        toggleTaskCheckbox(view, resolveToggleFrom(span, this));
        // Return focus to the editor so the keyboard user can keep
        // typing — without this, focus stays on the now-replaced (or
        // about-to-be-stale) widget DOM and the next keystroke goes
        // nowhere (Codex round-3 #23 / EH round-3 minor). This runs
        // UNCONDITIONALLY, not just on a successful toggle: Space/Enter
        // has already preventDefault'd, so on any of toggleTaskCheckbox's
        // false-returning guard paths (stale-from, readOnly, dead-view
        // catch) focus would otherwise be stranded on the span. The
        // mousedown handler intentionally does NOT do this (mouse users
        // expect their pointer to drive the next action).
        view.focus();
      }
    });

    return span;
  }

  updateDOM(dom: HTMLElement, _view: EditorView, from: CheckboxWidget): boolean {
    // CM calls updateDOM only when eq() returned false, passing the prior
    // same-class widget as `from`. eq() keys on (checked, from). A checked
    // change is a TOGGLE: rebuild (return false) so the full DOM reconstruction
    // via toDOM() runs — the DOM swap invalidates the old span's dataset and
    // event capture, and the keydown handler's unconditional view.focus() (not
    // this method) is now responsible for restoring focus after a toggle
    // (round-3 #23). This optimization targets edits ABOVE the checkbox, not
    // toggles. A pure from-shift reuses the span: re-point the `toggleTarget`
    // channel the mousedown/keydown handlers actually read (dataset.from is
    // inspection-only, see toDOM) and refresh aria-label per the widget's
    // (checked, from)-change contract.
    if (!dom.classList.contains("quoll-task-checkbox")) {
      return false;
    }
    if (from.checked !== this.checked) {
      return false;
    }
    dom.dataset.from = String(this.from);
    toggleTarget.set(dom, this.from);
    dom.setAttribute(
      "aria-label",
      this.label.length > 0 ? `Task: ${this.label}` : "Task list item"
    );
    return true;
  }

  ignoreEvent(): boolean {
    // Return true so CodeMirror does not synthesize a state update from
    // widget-originated events. Our own handlers drive state changes
    // via toggleTaskCheckbox.
    return true;
  }
}
