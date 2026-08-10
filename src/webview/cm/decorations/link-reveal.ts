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
// between `[` and `]`) IF a click on the destination would DO something.
// Actionability is decided by cm/link-target.ts, the same classifier
// cm/link-handlers.ts gates the click on, so the pointer cursor means "the
// webview will act on this click". Before that gate existed, a fragment
// (`[x](#sec)`) or a relative non-.md link (`[x](./photo.png)`) rendered
// identically to a working link and then did nothing. In REVEALED state the
// marker drops for every link (user is editing, not clicking).
//
// Read that promise at its true strength — it is NOT "this link opens". The
// webview owns no path, so it cannot evaluate host-side containment: a
// relative `.md` target resolving outside the workspace still classifies as
// actionable, still gets a pointer, and is dropped log-only by the host
// (links/handle-open-link.ts) after preventDefault has already eaten the caret
// move. Closing that one needs a host→webview rejection channel, not a cursor
// change.
//
// Reveal-trigger range is the OUTER Link node range (mirror of
// inline-mark-reveal). Click-to-open behaviour is wired separately in
// src/webview/cm/link-handlers.ts.

import { Decoration, type DecorationSet } from "@codemirror/view";

import { decodeMarkdownDestination } from "../../../markdown/url-decode.js";
import { classifyLinkTarget, isActionableLinkTarget } from "../link-target.js";
import { buildSortedRangeSet } from "../sorted-range-set.js";

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
    // "from is non-decreasing" contract. buildSortedRangeSet sorts by
    // from→to before insertion.
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
          // HIDDEN, the content range is non-empty, it is inside the visible
          // window, AND a click on the destination would actually DO something
          // (the honest-pointer contract in the header). `classifyLinkTarget` is
          // the SAME function link-handlers.ts gates the click on, so cursor and
          // behaviour cannot disagree.
          //
          // Cost: one doc slice + decode + classify per VISIBLE link whose marks
          // are hidden — placed last in the && chain so it runs only for links
          // that would otherwise get the marker, and bounded by the visible
          // range like every other walk in this provider.
          //
          // NOT wrapped in try/catch on purpose: classifyLinkTarget is total by
          // contract (pinned in test/webview/cm-link-target.test.ts). Catching
          // here would turn a future totality regression into a silently
          // missing cursor instead of a loud CI failure.
          if (
            !revealed &&
            contentStart !== null &&
            contentEnd !== null &&
            contentStart < contentEnd &&
            contentStart < range.to &&
            range.from < contentEnd &&
            isActionableLinkTarget(
              classifyLinkTarget(
                decodeMarkdownDestination(ctx.state.doc.sliceString(urlChild.from, urlChild.to))
              )
            )
          ) {
            out.push({ from: contentStart, to: contentEnd, deco: CLICKABLE });
          }
        },
      });
    }
    return buildSortedRangeSet(out, (entry) => [entry.from, entry.to, entry.deco]);
  },
};
