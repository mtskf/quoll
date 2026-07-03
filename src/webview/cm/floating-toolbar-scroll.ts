// Floating-toolbar scroll-hide. A display-only, shared scroll-direction
// observer for the two floating chrome buttons (outline toggle + switch-editor
// toggle) and the outline panel. Scrolling DOWN slides them off the top edge;
// scrolling UP brings them back; they are ALWAYS shown near the very top.
//
// The observer owns ONE `scroll` listener on `view.scrollDOM` (the .cm-scroller)
// and drives BOTH buttons through a single class on the `.quoll-editor` host —
// so there is one direction source, and the two button-owning ViewPlugins
// (cm/outline, cm/switch-editor) are NOT touched. Pure view chrome: no document
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
