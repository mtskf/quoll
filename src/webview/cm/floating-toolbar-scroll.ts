// Floating-toolbar scroll-hide. A display-only, shared scroll-direction
// observer for the two floating chrome buttons (outline toggle + switch-editor
// toggle) and the outline panel. Scrolling DOWN slides them off the top edge;
// scrolling UP brings them back; they are ALWAYS shown near the very top.
//
// The observer owns ONE `scroll` listener on `view.scrollDOM` (the .cm-scroller)
// and drives BOTH buttons through a single class on the `.quoll-editor` host —
// so there is one direction source, and the two button-owning ViewPlugins
// (cm/outline, cm/switch-editor) are NOT touched. Alongside the class it toggles
// the `inert` attribute on the chrome so hidden toggles / panel leave the focus
// + a11y tree IMMEDIATELY (the CSS `visibility:hidden` is delayed until the
// slide finishes — see setChromeHidden). Pure view chrome: no document
// mutation, no CodeMirror change, no write-lock, no protocol message.
//
// The direction→visibility decision is the pure `nextToolbarScrollState` below,
// pinned by unit tests; the ViewPlugin (Task 2) is a thin adapter that reads
// scrollTop, calls it, and toggles the host class.
//
// KNOWN CONSEQUENCE (design-review F3): the observer does NOT distinguish user
// scrolling from programmatic scrollTop changes (the editor-switch caret
// handoff's scrollIntoView, an outline jump, image-load reflow, …). By design
// this is a Medium-style toolbar that hides on ANY downward scroll regardless
// of source; the chrome always returns at the top or on the next upward scroll.
// Guarding against programmatic scroll would couple this module to the
// caret/outline modules — deliberately avoided.

import type { Extension } from "@codemirror/state";
import { type EditorView, type PluginValue, ViewPlugin } from "@codemirror/view";

/** Whether the floating chrome is on-screen or slid off the top edge. */
export type ToolbarVisibility = "shown" | "hidden";

/** Observer state: the current visibility plus the scroll ANCHOR the next
 *  delta is measured against. The anchor is held fixed while inside the
 *  hysteresis dead-zone so slow drift accumulates toward the flip point
 *  (a per-tick delta would reset every tick and never fire on gentle scroll). */
export type ToolbarScrollState = { visibility: ToolbarVisibility; anchor: number };

/** The single class the observer stamps on the `.quoll-editor` host. CSS
 *  (styles.css) slides both toggles + the outline panel when it is present. */
export const CHROME_HIDDEN_CLASS = "quoll-chrome-hidden";

/** The floating chrome the observer removes from the focus / a11y tree while
 *  hidden. Kept in lockstep with the `.quoll-chrome-hidden …` CSS selectors.
 *  The CSS `visibility:hidden` is DELAYED until the 0.2s slide finishes
 *  (`visibility 0s 0.2s`), so on its own it would leave the offscreen toggles /
 *  panel keyboard-focusable for that window; toggling `inert` from JS in sync
 *  with the class closes it IMMEDIATELY (set on hide, cleared on show). Queried
 *  at each transition (never cached) so plugin construction order and the
 *  lazily-shown outline panel are handled uniformly. */
export const CHROME_SELECTOR =
  ".quoll-outline-toggle, .quoll-switch-editor-toggle, .quoll-outline-panel";

/** Default jitter dead-zone (px). Movement within this of the anchor does NOT
 *  flip visibility, so the chrome never flickers on a trackpad wiggle. */
const DEFAULT_HYSTERESIS_PX = 4;

/** Default "always shown" band at the top of the document (px). Within it the
 *  chrome is unconditionally shown, so it is never stuck hidden at the top. */
const DEFAULT_TOP_THRESHOLD_PX = 8;

/** Pure anchor-based direction→visibility mapping. Given the previous state
 *  (visibility + anchor) and the current scrollTop, decide the next state:
 *   - at/near the top (scrollTop <= topThreshold) → "shown", re-anchor here;
 *   - moved DOWN from the anchor past the dead-zone → "hidden", re-anchor here;
 *   - moved UP from the anchor past the dead-zone → "shown", re-anchor here;
 *   - inside the dead-zone → keep `prev` UNCHANGED (state AND anchor), so a slow
 *     sub-threshold drift accumulates instead of resetting each tick.
 *  Pinned by unit tests; the ViewPlugin is a thin adapter over this. */
export function nextToolbarScrollState(
  prev: ToolbarScrollState,
  scrollTop: number,
  opts?: { hysteresis?: number; topThreshold?: number }
): ToolbarScrollState {
  const hysteresis = opts?.hysteresis ?? DEFAULT_HYSTERESIS_PX;
  const topThreshold = opts?.topThreshold ?? DEFAULT_TOP_THRESHOLD_PX;
  if (scrollTop <= topThreshold) {
    return { visibility: "shown", anchor: scrollTop };
  }
  const delta = scrollTop - prev.anchor;
  if (delta > hysteresis) {
    return { visibility: "hidden", anchor: scrollTop };
  }
  if (delta < -hysteresis) {
    return { visibility: "shown", anchor: scrollTop };
  }
  return prev;
}

/** The scroll-direction observer. ONE `scroll` listener on `view.scrollDOM`
 *  drives the `.quoll-editor` host class through the pure mapping above. */
class FloatingToolbarScroll implements PluginValue {
  private readonly hostEl: HTMLElement;
  private readonly scroller: HTMLElement;
  private state: ToolbarScrollState;
  private readonly onScroll = (): void => this.handleScroll();

  constructor(view: EditorView) {
    // Mounted inside the `.quoll-editor` host (the positioned overlay ancestor
    // the two toggles attach to). Fail fast rather than stamping the class onto
    // CodeMirror's own managed DOM — same contract as quollOutline /
    // quollSwitchEditor.
    const hostEl = view.dom.closest(".quoll-editor");
    if (!(hostEl instanceof HTMLElement)) {
      throw new Error(
        "quollFloatingToolbarScroll: EditorView must be mounted inside a .quoll-editor host"
      );
    }
    this.hostEl = hostEl;
    this.scroller = view.scrollDOM;
    this.state = { visibility: "shown", anchor: this.scroller.scrollTop };
    // passive: the handler never preventDefaults — it only reads scrollTop and,
    // at a visibility transition, toggles the host class + the chrome `inert`
    // attribute, so the browser can keep scrolling smoothly.
    this.scroller.addEventListener("scroll", this.onScroll, { passive: true });
  }

  private handleScroll(): void {
    const next = nextToolbarScrollState(this.state, this.scroller.scrollTop);
    const changed = next.visibility !== this.state.visibility;
    // Commit the new state (incl. the possibly-advanced anchor) every tick, but
    // keep the DOM mutation OFF the hot path: it fires ONLY at a visibility
    // transition, never per scroll tick. Do NOT move it above this guard
    // (design-review: avoids per-event style recalc / jank).
    this.state = next;
    if (!changed) {
      return;
    }
    this.setChromeHidden(next.visibility === "hidden");
  }

  /** Drive the host class AND the chrome `inert` attribute together. `inert`
   *  removes the offscreen toggles / panel from the focus + a11y tree the
   *  instant the hide begins, ahead of the CSS `visibility:hidden` that is
   *  delayed until the slide finishes. Queried per transition (off the hot
   *  path) so the lazily-mounted outline panel is covered whenever it exists. */
  private setChromeHidden(hidden: boolean): void {
    this.hostEl.classList.toggle(CHROME_HIDDEN_CLASS, hidden);
    for (const el of this.hostEl.querySelectorAll(CHROME_SELECTOR)) {
      el.toggleAttribute("inert", hidden);
    }
  }

  destroy(): void {
    this.scroller.removeEventListener("scroll", this.onScroll);
    // Clear the class AND inert so a re-mount (or a lingering host node in a
    // test) never inherits a stale hidden state. Order matters: remove the
    // listener first so no post-destroy scroll event can re-hide after this.
    this.setChromeHidden(false);
  }
}

/** The floating-toolbar scroll-hide extension: a single ViewPlugin that hides
 *  the chrome on scroll-down and reveals it on scroll-up / at the top. */
export function quollFloatingToolbarScroll(): Extension {
  return ViewPlugin.define((view) => new FloatingToolbarScroll(view));
}
