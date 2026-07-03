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

import { WidgetType } from "@codemirror/view";

export class ThematicBreakWidget extends WidgetType {
  eq(other: WidgetType): boolean {
    // Stateless: every ThematicBreakWidget renders an identical rule, so any two
    // are interchangeable and CM may reuse the DOM. instanceof (NOT bare `true`)
    // guards against reusing a foreign widget's DOM if a different widget ever
    // lands on the same range — matches FrontmatterBlockWidget / CheckboxWidget.
    return other instanceof ThematicBreakWidget;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "quoll-thematic-break";
    el.setAttribute("role", "separator");
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
