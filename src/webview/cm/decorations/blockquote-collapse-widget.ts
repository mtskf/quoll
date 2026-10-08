// Block widget for the blockquote "Show more" / "Show less" bar. Display-only: a LEFT click
// toggles the collapse StateEffect (blockquote-collapse-state.ts) and NEVER dispatches a
// document change. DOM and event contract come from the shared renderer
// (../collapse/collapse-toggle-widget.ts).
//
// No `patchDOM`: a changed widget rebuilds, so a click handler never holds a stale key.

import type { EditorView } from "@codemirror/view";
import { renderCollapseBar } from "../collapse/collapse-toggle-widget.js";
import { QuollWidget } from "../widget-base.js";
import { toggleBlockquoteCollapse } from "./blockquote-collapse-state.js";
import { CALLOUT_CLASS, type CalloutType, calloutClassForType } from "./callout.js";

export class BlockquoteCollapseToggleWidget extends QuollWidget {
  readonly widgetName = "BlockquoteCollapseToggleWidget";

  constructor(
    /** First line's `line.from` of the owning quote — the toggle key. */
    readonly key: number,
    /** true → the "Show less" bar; false → "Show more". */
    readonly expanded: boolean,
    /** Count of concealed lines — shown in the label and part of sameAs(). */
    readonly hiddenCount: number,
    /** Callout type, so the bar can wear the panel's callout classes. */
    readonly calloutType: CalloutType | null
  ) {
    super();
  }

  protected sameAs(other: QuollWidget): boolean {
    return (
      other instanceof BlockquoteCollapseToggleWidget &&
      other.key === this.key &&
      other.expanded === this.expanded &&
      other.hiddenCount === this.hiddenCount &&
      other.calloutType === this.calloutType
    );
  }

  protected render(view: EditorView, signal: AbortSignal): HTMLElement {
    const root = renderCollapseBar({
      classes: {
        bar: "quoll-blockquote-collapse-bar",
        barCollapsed: "quoll-blockquote-collapse-bar-collapsed",
        toggle: "quoll-blockquote-collapse-toggle",
        label: "quoll-blockquote-collapse-label",
      },
      expanded: this.expanded,
      hiddenCount: this.hiddenCount,
      signal,
      onToggle: () => toggleBlockquoteCollapse(view, this.key, !this.expanded),
    });
    if (this.calloutType !== null) {
      root.classList.add(CALLOUT_CLASS, calloutClassForType(this.calloutType));
    }
    return root;
  }

  ignoreEvent(): boolean {
    // Our own listener drives the toggle; CM must not synthesize a state update from
    // widget-originated events.
    return true;
  }
}
