// Block widget rendering the "Show more" / "Show less" toggle bar for a long
// fenced code block. Display-only: a LEFT click toggles the collapse StateEffect
// (fenced-code-collapse-state.ts) and NEVER dispatches a document change, so the
// source round-trips byte-identically. The bar is styled by quollCollapseToggleTheme
// (cm/theme.ts) to blend with the code panel.
//
// Icons: Lucide (https://lucide.dev, MIT) chevron-down / chevron-up, inlined as
// static SVG via createElementNS — per the project's supply-chain default-deny we
// do not add the `lucide` package for two static glyphs (and createElementNS
// avoids innerHTML, so there is no CSP/inline-style concern). Same approach as
// fenced-code-copy-button-widget.ts.

import { type EditorView, WidgetType } from "@codemirror/view";
import { toggleFencedCollapse } from "./fenced-code-collapse-state.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide chevron-down / chevron-up path data (exported so the widget test can
// assert which glyph is shown).
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

export class FencedCollapseToggleWidget extends WidgetType {
  constructor(
    /** Open-fence line.from offset of the owning block — the toggle key. */
    readonly key: number,
    /** Current state: true → this is the "Show less" bar; false → "Show more". */
    readonly expanded: boolean,
    /** Count of concealed body lines (collapsed state) — shown in the label and
     *  part of eq() so the label refreshes when the body grows/shrinks. */
    readonly hiddenCount: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof FencedCollapseToggleWidget &&
      other.key === this.key &&
      other.expanded === this.expanded &&
      other.hiddenCount === this.hiddenCount
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement("div");
    root.className = "quoll-fenced-collapse-bar";
    // The `-collapsed` state class marks the COLLAPSED "Show more" bar, which is the
    // panel's visible bottom (body tail + closing fence are replaced) and so must carry
    // the rounded/padded footer (collapseToggleThemeSpec). The EXPANDED "Show less" bar
    // is a side:1 widget after the last body line; whether IT is the footer depends on
    // the row rendered directly below it — a revealed closing fence (caret in the block)
    // is the footer and the bar stays flat, else (caret out) the closing fence collapses
    // and the bar itself must round. That distinction is made in CSS from the rendered
    // adjacency (`:has(+ …)` in collapseToggleThemeSpec), NOT here, so the widget only
    // needs to flag the collapsed state. Toggling a class (not a :has([aria-expanded])
    // selector) keeps that flag happy-dom-assertable.
    root.classList.toggle("quoll-fenced-collapse-bar-collapsed", !this.expanded);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "quoll-fenced-collapse-toggle";
    button.setAttribute("aria-expanded", this.expanded ? "true" : "false");

    button.appendChild(makeChevron(this.expanded ? CHEVRON_UP_PATH : CHEVRON_DOWN_PATH));
    const label = document.createElement("span");
    label.className = "quoll-fenced-collapse-label";
    label.textContent = this.expanded
      ? "Show less"
      : `Show ${this.hiddenCount} more ${this.hiddenCount === 1 ? "line" : "lines"}`;
    button.appendChild(label);

    // mousedown: block CodeMirror's caret-on-mousedown so clicking never moves the
    // selection into a (possibly concealed) line. preventDefault on mousedown does
    // NOT cancel the click, so keyboard Enter/Space still activates the button.
    button.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      toggleFencedCollapse(view, this.key, !this.expanded);
    });

    root.appendChild(button);
    return root;
  }

  ignoreEvent(): boolean {
    // Our own listener drives the toggle; CM must not synthesize a state update
    // from widget-originated events.
    return true;
  }
}
