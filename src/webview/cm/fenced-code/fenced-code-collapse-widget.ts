// Block widget rendering the "Show more" / "Show less" toggle bar for a long
// fenced code block. Display-only: a LEFT click toggles the collapse StateEffect
// (fenced-code-collapse-state.ts) and NEVER dispatches a document change, so the
// source round-trips byte-identically. The bar is styled by quollCollapseToggleTheme
// (cm/theme.ts) to blend with the code panel.
//
// The DOM, icons and event contract are the shared renderer's (../collapse/
// collapse-toggle-widget.ts); this class supplies the fenced class names and the toggle.

import type { EditorView } from "@codemirror/view";
import {
  CHEVRON_DOWN_PATH,
  CHEVRON_UP_PATH,
  renderCollapseBar,
} from "../collapse/collapse-toggle-widget.js";
import { QuollWidget } from "../widget-base.js";
import { toggleFencedCollapse } from "./fenced-code-collapse-state.js";

// Re-exported so the widget test (and any importer) keeps its import path.
export { CHEVRON_DOWN_PATH, CHEVRON_UP_PATH };

export class FencedCollapseToggleWidget extends QuollWidget {
  readonly widgetName = "FencedCollapseToggleWidget";

  constructor(
    /** Open-fence line.from offset of the owning block — the toggle key. */
    readonly key: number,
    /** Current state: true → this is the "Show less" bar; false → "Show more". */
    readonly expanded: boolean,
    /** Count of concealed body lines (collapsed state) — shown in the label and
     *  part of sameAs() so the label refreshes when the body grows/shrinks. */
    readonly hiddenCount: number
  ) {
    super();
  }

  protected sameAs(other: QuollWidget): boolean {
    return (
      other instanceof FencedCollapseToggleWidget &&
      other.key === this.key &&
      other.expanded === this.expanded &&
      other.hiddenCount === this.hiddenCount
    );
  }

  protected render(view: EditorView, signal: AbortSignal): HTMLElement {
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
    return renderCollapseBar({
      classes: {
        bar: "quoll-fenced-collapse-bar",
        barCollapsed: "quoll-fenced-collapse-bar-collapsed",
        toggle: "quoll-fenced-collapse-toggle",
        label: "quoll-fenced-collapse-label",
      },
      expanded: this.expanded,
      hiddenCount: this.hiddenCount,
      signal,
      onToggle: () => toggleFencedCollapse(view, this.key, !this.expanded),
    });
  }

  ignoreEvent(): boolean {
    // Our own listener drives the toggle; CM must not synthesize a state update
    // from widget-originated events.
    return true;
  }
}
