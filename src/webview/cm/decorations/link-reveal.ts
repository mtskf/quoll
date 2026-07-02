// Inline link syntax-token reveal. Walks the Lezer GFM tree for Link nodes
// (`[text](url)` form ONLY — reference links and images are out of scope
// for C4b: reference links have no URL child to gate; images live in C7).
//
// For each inline Link with a URL child, emits decorations for every
// LinkMark child (`[`, `]`, `(`, `)`) and the URL child:
//   - REVEAL (Decoration.mark "quoll-syntax-reveal") when any selection
//     range intersects the outer Link node range. Mirror of the inline-
//     mark-reveal contract.
//   - HIDE (Decoration.replace) otherwise. Each child's exact [from, to)
//     range; no structural-whitespace absorption because inline link
//     syntax abuts the content directly (no semantic space between `]`
//     and `(`).
// Additionally, when HIDDEN, emits a Decoration.mark "quoll-link-clickable"
// over the link's inline content range (`[text]` interior — the substring
// between `[` and `]`). CSS gives this `cursor: pointer` so the user sees
// the link is openable; in REVEALED state the marker drops (user is
// editing, not clicking).
//
// Reveal-trigger range is the OUTER Link node range (mirror of
// inline-mark-reveal). Click-to-open behaviour is wired separately in
// src/webview/cm/link-handlers.ts.

import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";

import { HIDE, intersectsAnySelection, REVEAL_MARK } from "./shared.js";
import type { DecorationProvider } from "./types.js";

/** Marker applied to the link's inline content range while HIDDEN so the
 *  user sees a pointer cursor. CSS rule lives in src/webview/styles.css
 *  (`.quoll-link-clickable { cursor: pointer; }`). Sharing the instance
 *  for the same RangeSet dedup benefit shared.ts uses for REVEAL_MARK. */
const CLICKABLE = Decoration.mark({ class: "quoll-link-clickable" });

const LINK_MARK_NAMES = new Set(["LinkMark", "URL"]);

export const linkReveal: DecorationProvider = {
  build(ctx): DecorationSet {
    // Flat-array-then-sort pattern (review fix #9 from C4a's inline-mark
    // provider): Lezer pre-order DFS visits a Link's children between its
    // own enter/leave, so emitting straight to the builder violates the
    // "from is non-decreasing" contract. Sort by from→to before insertion.
    const out: Array<{ from: number; to: number; deco: Decoration }> = [];
    for (const range of ctx.visibleRanges) {
      ctx.tree.iterate({
        from: range.from,
        to: range.to,
        enter: (node) => {
          if (node.name !== "Link") {
            return;
          }
          // Find the URL child. Inline-form Link has one; reference-form
          // does not. Skip the latter — C4b is inline-only.
          let urlChild: { from: number; to: number } | null = null;
          let contentStart: number | null = null;
          let contentEnd: number | null = null;
          const sub = node.node.cursor();
          if (!sub.firstChild()) {
            return;
          }
          // First child should be a LinkMark `[` at node.from. Use it as
          // the start of inline content (content starts AFTER `[`).
          // Then iterate siblings: a `]` LinkMark closes the inline
          // content; a `(` LinkMark + URL + `)` LinkMark form the URL
          // tail. Reference-form has no `(` so urlChild stays null.
          do {
            if (sub.name === "LinkMark") {
              const ch = ctx.state.doc.sliceString(sub.from, sub.to);
              if (ch === "[") {
                contentStart = sub.to;
              } else if (ch === "]") {
                contentEnd = sub.from;
              }
            } else if (sub.name === "URL") {
              urlChild = { from: sub.from, to: sub.to };
            }
          } while (sub.nextSibling());
          if (urlChild === null) {
            // Reference-form (or malformed inline) — skip silently.
            return;
          }
          const revealed = intersectsAnySelection(ctx.selection, node.from, node.to);
          // Re-walk children to emit a decoration per LinkMark + URL,
          // bounded by the visible range (review fix #9 from C4a — outer
          // tree.iterate is bounded but cursor.nextSibling is not).
          const sub2 = node.node.cursor();
          if (!sub2.firstChild()) {
            return;
          }
          do {
            if (LINK_MARK_NAMES.has(sub2.name)) {
              if (sub2.from < range.to && range.from < sub2.to) {
                out.push({
                  from: sub2.from,
                  to: sub2.to,
                  deco: revealed ? REVEAL_MARK : HIDE,
                });
              }
            }
          } while (sub2.nextSibling());
          // Emit the clickable marker over [contentStart, contentEnd) when
          // HIDDEN and the content range is non-empty AND inside the
          // visible window.
          if (
            !revealed &&
            contentStart !== null &&
            contentEnd !== null &&
            contentStart < contentEnd &&
            contentStart < range.to &&
            range.from < contentEnd
          ) {
            out.push({ from: contentStart, to: contentEnd, deco: CLICKABLE });
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
