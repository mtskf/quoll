import type { EditorView } from "@codemirror/view";
import { QuollWidget } from "../widget-base.js";

export class NumericEntityWidget extends QuollWidget {
  readonly widgetName = "NumericEntityWidget";

  // `highlightClass` is what the syntax highlighter would give the source text:
  // marks from lower-ranked decoration sets never wrap a replacing widget
  // (RangeSet.spans → activeForPoint), so the widget re-applies them itself.
  constructor(
    readonly text: string,
    readonly highlightClass: string
  ) {
    super();
  }

  protected sameAs(other: QuollWidget): boolean {
    return (
      other instanceof NumericEntityWidget &&
      other.text === this.text &&
      other.highlightClass === this.highlightClass
    );
  }

  protected render(_view: EditorView, _signal: AbortSignal): HTMLElement {
    const el = document.createElement("span");
    el.className = `quoll-numeric-entity ${this.highlightClass}`.trimEnd();
    el.textContent = this.text;
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}
