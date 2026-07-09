// Bullet-list marker dot. Walks the Lezer GFM tree for `ListMark` nodes inside a
// `BulletList` and emits one Decoration.mark({ class: "quoll-bullet-marker" })
// per marker whose LINE no selection range intersects. The mark hides the raw
// `-`/`*`/`+` glyph (color: transparent, in cm/theme.ts) and paints a round dot
// via ::before — display-only, the byte is untouched, so Markdown round-trips
// unchanged.
//
// A MARK (not a replace widget) is deliberate: the glyph keeps its natural
// advance width in BOTH the dotted and the revealed (caret-on) state, so
// revealing/hiding never shifts the content column or perturbs the
// list-hang-indent geometry (which approximates the marker as one space). A
// replace widget would have to match the glyph advance to avoid a caret-on/off
// jump; the transparent-glyph + ::before-dot overlay sidesteps that entirely.
//
// Reveal-trigger is per-line, mirroring heading/blockquote/inline-mark/
// task-checkbox: a selection range intersecting the marker line emits nothing,
// so the raw source shows and stays editable in place.
//
// Task items are SKIPPED through the shared geometry resolver (the single source
// of truth for the bullet/ordered fold policy): taskCheckboxReveal already
// replaces `- [ ]` starting at this same ListMark.from, so it owns the marker
// column. Ordered lists (`N.`) are out of scope: only BulletList markers dot.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

import {
  resolveContentlessTaskMarkerGeometry,
  resolveTaskMarkerGeometry,
} from "../list/list-geometry.js";
import { intersectsAnySelection } from "./shared.js";
import type { BuildContext, DecorationProvider } from "./types.js";

// Lezer SyntaxNode, derived from the build tree (narrow dep surface — same
// strategy as list-geometry.ts / types.ts).
type SyntaxNode = BuildContext["tree"]["topNode"];

// Depth-varied marks (list-marker-restyle): index = min(visualDepth, 3) − 1.
// d1 = filled dot, d2 = hollow dot, d3+ = dash bar (shapes in cm/theme.ts). The
// shared `quoll-bullet-marker` class carries the hide-glyph + first-line gap.
const bulletMarkerDecoByDepth = [
  Decoration.mark({ class: "quoll-bullet-marker quoll-bullet-marker-d1" }),
  Decoration.mark({ class: "quoll-bullet-marker quoll-bullet-marker-d2" }),
  Decoration.mark({ class: "quoll-bullet-marker quoll-bullet-marker-d3" }),
];

// Visual nesting depth = count of BulletList/OrderedList ancestors (top-level
// bullet = 1). Counting ordered containers too means a bullet nested inside an
// ordered list reads at its visual indent level — the intended depth cue.
function listDepth(item: SyntaxNode): number {
  let depth = 0;
  for (let p: SyntaxNode | null = item; p !== null; p = p.parent) {
    if (p.name === "BulletList" || p.name === "OrderedList") {
      depth++;
    }
  }
  return depth;
}

export const bulletMarkerReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    const out: Array<{ from: number; to: number; depth: number }> = [];
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (node.name !== "ListMark") {
            return;
          }
          // Lezer's iterate uses TOUCH semantics, so a ListMark sitting exactly
          // on the window's closing edge is entered even though it starts at
          // range.to. Require a real half-open overlap so a marker just outside
          // the visible window is never emitted (mirrors taskCheckboxReveal's
          // boundary guard).
          if (node.from >= range.to || node.to <= range.from) {
            return;
          }
          const item = node.node.parent;
          // Bullet lists only — an ordered list's `N.` keeps its numeral.
          if (item === null || item.name !== "ListItem" || item.parent?.name !== "BulletList") {
            return;
          }
          // A rendered bullet task's `- [ ]` is owned by taskCheckboxReveal (its
          // checkbox replace starts at this same ListMark.from). Route the
          // ownership check through the shared geometry resolver — the single
          // source of truth for the bullet/ordered fold policy — so a dot here
          // never collides with the checkbox and a future grammar change
          // surfaces in one place. resolveTaskMarkerGeometry returns non-null
          // with isBullet only for a VALID-marker bullet task; an invalid-marker
          // Task on a stale tree renders no checkbox, so the ListMark is free and
          // legitimately gets its dot.
          const content = node.node.nextSibling;
          if (content?.name === "Task" && resolveTaskMarkerGeometry(ctx.state, content)?.isBullet) {
            return;
          }
          // Content-less bullet task `- [ ]`: no Task node, but the checkbox reveal
          // still replaces [ListMark.from, TaskMarker.to) — swallowing this `-`. Skip
          // the dot so it never collides with the checkbox. (Ordered `1. [ ]` is
          // isBullet:false → not skipped here; ordered lists never dot anyway.)
          if (resolveContentlessTaskMarkerGeometry(ctx.state, item)?.isBullet) {
            return;
          }
          const line = ctx.state.doc.lineAt(node.from);
          if (intersectsAnySelection(ctx.selection, line.from, line.to)) {
            return;
          }
          out.push({ from: node.from, to: node.to, depth: listDepth(item) });
        },
      });
    }
    // Sort so RangeSetBuilder sees a non-decreasing `from` (mirrors
    // taskCheckboxReveal). The strict overlap guard above means a 1-char
    // ListMark overlaps at most one of CM's disjoint visibleRanges, so it is
    // collected once — no de-dup needed.
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to, depth } of out) {
      builder.add(from, to, bulletMarkerDecoByDepth[Math.min(depth, 3) - 1]);
    }
    return builder.finish();
  },
};
