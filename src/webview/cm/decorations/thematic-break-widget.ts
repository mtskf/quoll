// Display-only widget that renders a Markdown thematic break (`---` / `***` /
// `___`) as a horizontal rule. Emitted as an INLINE Decoration.replace by
// thematic-break-reveal.ts when the caret is OFF the rule's line; the raw
// source is revealed (dim) when the caret enters, so the bytes round-trip
// identically. Stateless — every thematic break renders the same rule, so
// eq() is always true and CodeMirror reuses the DOM across rebuilds.
//
// DOM is built with document.createElement (NOT innerHTML — the src/**
// choke-point test default-denies innerHTML). The <span> is styled full-width
// via styles.css `.quoll-thematic-break` (@layer widget); role="separator"
// gives the rendered rule the same semantics as an <hr> for assistive tech.
//
// `indentCols` (default 0) insets the rule for a break nested as a LIST-ITEM
// child (`- x\n\n  ---`): the reveal passes the source-indent column count, and
// the widget adds `padding-inline-start` of that many measured prose-spaces so
// the hairline (confined to the content box by styles.css `background-clip`)
// starts at the item's content column instead of the document margin. 0 for
// every top-level / container break, where the render is byte-identical to
// before this field existed.

import { WidgetType } from "@codemirror/view";

export class ThematicBreakWidget extends WidgetType {
  constructor(readonly indentCols = 0) {
    super();
  }

  eq(other: WidgetType): boolean {
    // Two widgets are interchangeable (CM may reuse the DOM) only when they
    // render the SAME rule — including the same list-child inset. instanceof
    // (NOT bare `true`) guards against reusing a foreign widget's DOM if a
    // different widget ever lands on the same range — matches
    // FrontmatterBlockWidget / CheckboxWidget.
    return other instanceof ThematicBreakWidget && other.indentCols === this.indentCols;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "quoll-thematic-break";
    el.setAttribute("role", "separator");
    if (this.indentCols > 0) {
      // Inset the rule to the list-item content column: one measured prose-space
      // (prose-space-metric.ts publishes `--quoll-prose-space` on `.cm-editor`,
      // cascading here) per source-indent column, matching the sibling nested
      // paragraph's literal leading spaces. styles.css confines the hairline to
      // the content box (`background-clip: content-box`), so this padding shifts
      // the visible rule right. Falls back to `1ch` (monospace-exact) before the
      // metric is measured.
      el.style.paddingInlineStart = `calc(${this.indentCols} * var(--quoll-prose-space, 1ch))`;
    }
    return el;
  }

  ignoreEvent(): boolean {
    // Let mouse events fall THROUGH to CodeMirror so a click on the rendered
    // rule places the caret on the HR line and reveals the raw source. This
    // widget is NOT atomic (no atomicRanges), so CM's native pointer→position
    // mapping is the click-to-reveal path — returning `true` would make CM
    // ignore clicks on the rule (eventBelongsToEditor short-circuits on a
    // widget whose ignoreEvent is true), breaking click-to-reveal. Contrast the
    // image / frontmatter block widgets, which ARE atomic and therefore dispatch
    // their own click→reveal instead.
    return false;
  }
}
