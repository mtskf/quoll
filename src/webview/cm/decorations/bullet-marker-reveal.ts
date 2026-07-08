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
import type { DecorationProvider } from "./types.js";

const bulletMarkerDeco = Decoration.mark({ class: "quoll-bullet-marker" });

export const bulletMarkerReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    const out: Array<{ from: number; to: number }> = [];
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
          out.push({ from: node.from, to: node.to });
        },
      });
    }
    // Sort so RangeSetBuilder sees a non-decreasing `from` (mirrors
    // taskCheckboxReveal). The strict overlap guard above means a 1-char
    // ListMark overlaps at most one of CM's disjoint visibleRanges, so it is
    // collected once — no de-dup needed.
    out.sort((a, b) => a.from - b.from || a.to - b.to);
    const builder = new RangeSetBuilder<Decoration>();
    for (const { from, to } of out) {
      builder.add(from, to, bulletMarkerDeco);
    }
    return builder.finish();
  },
};
