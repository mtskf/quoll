// Task-list checkbox reveal. Walks the Lezer GFM tree for Task nodes and emits
// one Decoration.replace({ widget }) per task whose LINE no selection range
// intersects. When a selection range intersects the task line, no decoration
// is emitted — the source `[ ]`/`[x]` renders as plain text and is editable in
// place (mirror of the heading/blockquote per-line reveal-trigger pattern).
//
// The widget is the CheckboxWidget class; this provider holds only the
// iteration + decoration-set logic so the emission contract can be pinned
// independently of widget DOM.
//
// The bullet/ordered fold policy lives in list-geometry.ts
// (resolveTaskMarkerGeometry) — shared with list-hang-indent so the checkbox
// replace span and the hang prefix column never drift (Codex F7).

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

import { findTaskMarker, resolveTaskMarkerGeometry } from "./list-geometry.js";
import { intersectsAnySelection } from "./shared.js";
import { CheckboxWidget } from "./task-checkbox-widget.js";
import type { DecorationProvider } from "./types.js";

// Re-exported so the marker-resolution unit test keeps its import site.
export { findTaskMarker };

// Immutable content-mute decoration for a COMPLETED task's content span. A module
// constant (bulletMarkerReveal precedent) — the spec never varies, so build it once.
// Styled by cm/theme.ts taskCompletedContentThemeSpec (`.quoll-task-completed-content`).
const completedContentDeco = Decoration.mark({ class: "quoll-task-completed-content" });

export const taskCheckboxReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    const out: Array<{ from: number; to: number; deco: Decoration }> = [];
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (node.name !== "Task") {
            return;
          }
          const geom = resolveTaskMarkerGeometry(ctx.state, node.node);
          if (geom === null) {
            return;
          }
          // C5b: replace from `foldFrom` (ListMark.from for bullet tasks so the
          // checkbox sits in the bullet column; TaskMarker.from for ordered /
          // drift). Overlap guard uses the widened start, NOT TaskMarker.from,
          // so a Task entered at the iterate window's closing edge still emits
          // when its bullet is visible (pinned by the boundary test).
          const replaceFrom = geom.foldFrom;
          if (!(replaceFrom < range.to && range.from < geom.taskMarkerTo)) {
            return;
          }
          const line = ctx.state.doc.lineAt(geom.taskMarkerFrom);
          if (intersectsAnySelection(ctx.selection, line.from, line.to)) {
            return;
          }
          const labelBody = ctx.state.doc
            .sliceString(geom.taskMarkerTo, line.to)
            .replace(/^[\s]+/, "")
            .slice(0, 80);
          out.push({
            from: replaceFrom,
            to: geom.taskMarkerTo,
            // Widget stores TaskMarker.from (NOT replaceFrom): toggleTaskCheckbox
            // dispatches at `markerFrom + 1`; passing the widened start would
            // toggle the wrong byte for bullet tasks.
            deco: Decoration.replace({
              widget: new CheckboxWidget(geom.checked, geom.taskMarkerFrom, labelBody),
            }),
          });
          // Completed-item recede: mute the checked task's CONTENT text. Same
          // reveal-trigger as the widget (emitted here → suppressed when the caret
          // is on the line, since the selection guard above already returned). The
          // guard `taskMarkerTo < line.to` skips an empty task (`- [x]`) so no
          // zero-width mark is built. This mark's `from` (taskMarkerTo) is always
          // GREATER than the widget replace's `from` (replaceFrom = ListMark.from /
          // TaskMarker.from < taskMarkerTo), and across tasks the ranges are on
          // disjoint lines — so the `out` sort by `from` never produces an equal-`from`
          // pair and RangeSetBuilder's from+startSide contract holds without a tiebreak.
          if (geom.checked && geom.taskMarkerTo < line.to) {
            out.push({ from: geom.taskMarkerTo, to: line.to, deco: completedContentDeco });
          }
        },
      });
    }
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<Decoration>();
    for (const entry of out) {
      builder.add(entry.from, entry.to, entry.deco);
    }
    return builder.finish();
  },
};
