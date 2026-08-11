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
// Actionability is decided in two stages — cm/link-target.ts classifies the
// destination string, cm/link-resolve.ts answers the part that depends on THIS
// document (does a `#slug` name a real heading?) — and cm/link-handlers.ts
// gates the click on that same pair, so the pointer cursor means "the webview
// will act on this click". Before that gate existed, a relative non-.md link
// (`[x](./photo.png)`) rendered identically to a working link and then did
// nothing. In REVEALED state the marker drops for every link (user is editing,
// not clicking).
//
// Read that promise at its true strength — it is NOT "this link opens". The
// webview owns no path, so it cannot evaluate host-side containment: a
// relative `.md` target resolving outside the workspace still classifies as
// actionable and still gets a pointer. The caret move is lost either way —
// preventDefault eats it before the host ever sees the escape — but the drop is
// not silent: links/handle-open-link.ts toasts on the containment arm alone
// (see its header for why that is the ONE rejection that speaks, and why an
// `open-link-rejected` host→webview channel, which would buy the caret move
// back, was considered and declined).
//
// A `#slug` fragment is the one class whose actionability depends on the
// DOCUMENT rather than the destination alone, so the pointer is gated on the
// same resolution the click uses (cm/link-resolve.ts): a slug that names a real
// heading gets the pointer and scrolls; an unmatched one gets neither, and the
// click stays a caret move. Two caveats, both deliberate. The lookup is memoised
// per Lezer tree, so a table-of-contents document pays one heading walk per
// rebuild rather than one per link. And this path passes NO parse budget — it
// reads only the viewport tree — so in a large document a heading far below the
// fold may not be visible to it yet, and its link shows no pointer while the
// click (which does force a complete parse) still works. That asymmetry is the
// safe direction: a missing affordance, never a dead click.
//
// Reveal-trigger range is the OUTER Link node range (mirror of
// inline-mark-reveal). Click-to-open behaviour is wired separately in
// src/webview/cm/link-handlers.ts.

import { Decoration, type DecorationSet } from "@codemirror/view";

import { decodeMarkdownDestination } from "../../../markdown/url-decode.js";
import { isActionableLinkTarget, resolveLinkTarget } from "../link-resolve.js";
import { classifyLinkTarget } from "../link-target.js";
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
          // (the honest-pointer contract in the header). `resolveLinkTarget` +
          // `isActionableLinkTarget` are the SAME pair link-handlers.ts gates
          // the click on, so the pointer never OVER-promises. It can
          // under-promise, and only in one documented way: the click passes a
          // parse budget and this path passes "viewport-only", so a heading
          // below the parsed region may show no pointer while the click still
          // scrolls (the header's asymmetry — a missing affordance, never a
          // dead click).
          //
          // Cost: one doc slice + decode + classify per VISIBLE link whose marks
          // are hidden — placed last in the && chain so it runs only for links
          // that would otherwise get the marker. NOTE the resolve step is the
          // one piece here NOT bounded by the visible range: the first FRAGMENT
          // link after a tree change pays a whole-tree heading walk
          // (buildSlugIndex), memoised per Tree afterwards — so once per
          // keystroke, not once per link. See cm/link-resolve.ts's
          // SLUG_INDEX_CACHE comment.
          //
          // NOT wrapped in try/catch on purpose: classifyLinkTarget is total by
          // contract (pinned against a hostile matrix in
          // test/webview/cm-link-target.test.ts) and resolveLinkTarget is total
          // by contract too — its one throwing primitive in reach, `doc.lineAt`
          // over a stale tree, is guarded in buildSlugIndex and pinned by
          // test/webview/cm-link-resolve.test.ts's "skips a heading the STALE
          // tree places past the end of a shortened document". Catching here
          // would turn a future totality regression into a silently missing
          // cursor instead of a loud CI failure.
          if (
            !revealed &&
            contentStart !== null &&
            contentEnd !== null &&
            contentStart < contentEnd &&
            contentStart < range.to &&
            range.from < contentEnd &&
            isActionableLinkTarget(
              resolveLinkTarget(
                ctx.state,
                ctx.tree,
                classifyLinkTarget(
                  decodeMarkdownDestination(ctx.state.doc.sliceString(urlChild.from, urlChild.to))
                ),
                // "viewport-only" is the whole reason this reads as a named arm
                // rather than an omitted budget: forcing a parse here would run
                // on every viewport and selection rebuild.
                "viewport-only"
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
