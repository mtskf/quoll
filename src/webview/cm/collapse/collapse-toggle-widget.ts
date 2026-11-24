// The one renderer behind every "Show more" / "Show less" bar (fenced code, blockquote):
// DOM, a11y and event contract live here so the clients cannot drift. Display-only: a LEFT
// click calls `onToggle`, which the client wires to its collapse effect — never a document
// change, so the source round-trips byte-identically.
//
// Icons: Lucide (https://lucide.dev, MIT) chevron-down / chevron-up, inlined as static SVG
// via createElementNS — per the project's supply-chain default-deny we do not add the
// `lucide` package for two static glyphs (and createElementNS avoids innerHTML, so there is
// no CSP/inline-style concern). Same approach as fenced-code-copy-button-widget.ts.

import type { EditorView } from "@codemirror/view";

const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide chevron-down / chevron-up path data (exported so widget tests can assert which
// glyph is shown).
export const CHEVRON_DOWN_PATH = "m6 9 6 6 6-6";
export const CHEVRON_UP_PATH = "m18 15-6-6-6 6";

function makeChevron(d: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  return svg;
}

export interface CollapseBarClasses {
  /** Root, e.g. "quoll-fenced-collapse-bar". */
  bar: string;
  /** Toggled on the collapsed ("Show more") state. */
  barCollapsed: string;
  /** The <button>. */
  toggle: string;
  /** The <span>. */
  label: string;
}

export function renderCollapseBar(args: {
  view: EditorView;
  classes: CollapseBarClasses;
  /** The owning block's key; tags the button so focus can follow the toggle. */
  blockKey: number;
  expanded: boolean;
  hiddenCount: number;
  signal: AbortSignal;
  /** `keepFocus`: the button held focus (keyboard activation) — see toggleCollapse. */
  onToggle: (keepFocus: boolean) => void;
}): HTMLElement {
  const { view, classes, blockKey, expanded, hiddenCount, signal, onToggle } = args;
  const root = document.createElement("div");
  root.className = classes.bar;
  root.classList.toggle(classes.barCollapsed, !expanded);

  const button = document.createElement("button");
  button.type = "button";
  button.className = classes.toggle;
  button.setAttribute("aria-expanded", expanded ? "true" : "false");
  button.dataset.collapseKey = String(blockKey);

  button.appendChild(makeChevron(expanded ? CHEVRON_UP_PATH : CHEVRON_DOWN_PATH));
  const label = document.createElement("span");
  label.className = classes.label;
  label.textContent = expanded
    ? "Show less"
    : `Show ${hiddenCount} more ${hiddenCount === 1 ? "line" : "lines"}`;
  button.appendChild(label);

  // mousedown: block CodeMirror's caret-on-mousedown so clicking never moves the selection
  // into a (possibly concealed) line. preventDefault on mousedown does NOT cancel the
  // click, so keyboard Enter/Space still activates the button.
  button.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    { signal }
  );
  button.addEventListener(
    "click",
    (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      // Toggling swaps this widget for the other state's (a different decoration at a
      // different offset), so a focused button — reached with Tab in read-only mode — would
      // drop focus to <body>, where neither Tab nor PageDown reaches the editor again. Hand
      // focus to the replacement button (CodeMirror redraws synchronously in dispatch). A
      // keyboard collapse scrolls its "Show more" into view in that dispatch, so it is
      // drawn; an expand does not scroll, and a long block's "Show less" can sit beyond the
      // viewport, undrawn — focus then goes to the scroller, which keeps keyboard scrolling
      // and the next Tab inside the editor. preventScroll: focus must not move the reader.
      // A mouse click never focuses the button (mousedown above), so this is keyboard-only.
      const hadFocus = button.ownerDocument.activeElement === button;
      onToggle(hadFocus);
      if (hadFocus) {
        const next =
          view.contentDOM.querySelector<HTMLElement>(
            `.${classes.toggle}[data-collapse-key="${blockKey}"]`
          ) ?? view.scrollDOM;
        next.focus({ preventScroll: true });
      }
    },
    { signal }
  );

  root.appendChild(button);
  return root;
}
