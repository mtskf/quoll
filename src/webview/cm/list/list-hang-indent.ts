// List soft-wrap hanging indent. Walks the Lezer GFM tree for ListItem nodes
// in the viewport and emits one Decoration.line per list-item MARKER line,
// carrying the hang expressions resolved by list-geometry.ts
// (resolveListItemHang). Each line gets an inline text-indent (negative) +
// matching padding-inline-start so soft-wrap continuation lines hang under the
// item's rendered content column instead of the left margin.
//
// Decoration-only: never mutates the document. CM maps the first line by
// `paddingLeft + min(0, textIndent)` (= 6px base) and continuation lines by
// the full padding; the 6px matches CM's baseTheme `.cm-line` left padding.
// Style is delivered INLINE (CSSOM cssText — CSP-exempt, highest cascade).
//
// Geometry (incl. the recursive task-fold re-basing for nested items) lives in
// list-geometry.ts; this module only iterates ListItems and assembles the
// style string. Hang widths are token-approximated (proportional body font ⇒
// visual columns are deterministic but ~0.3–0.5em looser than pixel-exact).
//
// Outline-step nesting (overturns PR1's Codex F2): a child re-based under a
// task parent is placed one NEST_STEP (2 source cols) PAST the parent's
// rendered content column, not flush at it. PR1 chose flush ("child marker
// under parent content"); user dogfooding (2026-06-21) found flush reads as
// un-nested under the task's WIDE checkbox widget — the child marker's left
// edge sat under the parent's text. The step (in list-geometry.ts's
// renderedMarkCol) makes each nesting level visibly indented. Plain parents
// (thin `-`) keep flush — their source indent already signals nesting.
//
// Selection-awareness (NEW — reverses the Codex-F6 selection-independence for
// the blockquote case): the plugin DOES rebuild on `selectionSet`, so the
// blockquote hang tracks blockquote-reveal (which flips the `> ` on selection).
// The rebuild cost is bounded — buildListHangIndent walks visibleRanges only,
// O(items·depth) over the viewport, the same cost as any reveal rebuild. A
// per-doc "has a blockquoted list" pre-check would be premature (KISS):
// non-blockquote docs recompute an identical set, harmless at viewport scale.
//
// Known limitations:
//   - Ancestor-task-fold reading-state glitch (Codex F6, still deferred): when
//     the caret sits on an ancestor task line, task-checkbox-reveal reverts that
//     line to raw `- [ ] ` source, but descendants still hang as if the fold
//     applied — a transient editing glitch that self-heals when the caret
//     leaves. A blockquoted task-nested child (`> - [ ] a` / `>   - b`) adds a
//     further wrinkle: the task-fold +MARKER/+NEST_STEP re-base persists even
//     though blockquote-reveal visually collapses the nesting. Fixing this would
//     require tracking which ancestor task lines are revealed; for a momentary
//     cosmetic offset that is not worth the added churn/complexity, the glitch
//     is deliberately left as a known F6 limitation (out of this PR's scope).
//   - Pixel approximation (Codex F3/F5; nested-bullet over-indent fix
//     2026-06-22): source-indentation columns are sized in
//     `var(--quoll-prose-space, 1ch)` — the prose font's MEASURED space advance
//     (prose-space-metric.ts) — not bare `ch`, because the body renders in a
//     proportional font where `ch` (the `0` glyph) is ~2× a space and made
//     wrapped nested lines hang deeper than the first-line text. The checkbox
//     column stays `em` (var(--quoll-task-marker-width)). Residuals (improved,
//     not eliminated): (a) a marker glyph (`-`, a digit) is approximated as one
//     space, so the hang is sub-pixel-loose for `- ` bullets and a few px for
//     long ordered markers; (b) a TAB-indented item leaves ~8px (down from
//     ~26px under the old `ch` sizing) — the rendered tab snaps to the
//     content-box tab-stop grid that `text-indent` shifts off, so its width
//     can't be predicted from the column count. Spaces (the dogfooded
//     TODO-file case) align to sub-pixel. The unit tests pin the EXPRESSION,
//     the integration test pins it reaching the DOM, and the deferred
//     browser-mode layout test (docs/TODO.md) is the pixel-exact gate.
//   - Blockquote-nested lists (`> - item`): FIXED. Caret-off: the `> ` prefix
//     width is subtracted via `blockquotePrefixCols` (per-QuoteMark sum, mirroring
//     blockquote-reveal's per-mark `Decoration.replace`). Leading whitespace before
//     the first `>` is NOT hidden by blockquote-reveal and is correctly excluded.
//     Caret-on: the `> ` is revealed, so 0 is passed and the full hang is kept.
//     The task-fold-in-blockquote combination (`> - [ ] a` / `>   - b`) remains
//     the separate F6 glitch documented above.
//   - CM private-styling coupling (Codex F-review, pre-existing since PR1): the
//     `6px` base and the `paddingLeft + min(0, textIndent)` first-line mapping
//     are CM @codemirror/view dist implementation values, not a public contract,
//     so a minor CM bump could shift them. Out of this PR's 1-purpose scope; the
//     proper fix (Quoll owns `.cm-line` start padding as a CSS variable that the
//     list decoration references, + a computed-padding contract test) needs the
//     same browser-mode harness as the deferred F3/F5 pixel test and is folded
//     into that follow-up TODO.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { quollSyntaxExclusionZones } from "../decorations/orchestrator.js";
import {
  absorbStructuralWhitespace,
  intersectsAnySelection,
  pointInExclusionZone,
} from "../decorations/shared.js";
import type { BuildContext } from "../decorations/types.js";
import { columnAt, resolveListItemHang } from "./list-geometry.js";

const CM_LINE_PAD_START = "6px";

/** Visual-column width of the blockquote `>`-prefix that blockquote-reveal
 *  HIDES on `line` caret-off. Sums EACH wrapping `QuoteMark`'s hidden width
 *  (`columnAt(absorbStructuralWhitespace(qm.to)) − columnAt(qm.from)`), exactly
 *  mirroring blockquote-reveal's per-`QuoteMark` `Decoration.replace`. Summing
 *  per-mark (not first-start→last-end) EXCLUDES leading whitespace before the
 *  first `>` (CommonMark allows up to 3 leading spaces, which blockquote-reveal
 *  does NOT hide), so `  > - item` reports 2, not 4.
 *
 *  Only `QuoteMark`s BEFORE `markerFrom` (the list marker's byte position) are
 *  counted: those are the wrapping blockquote prefix that shifts the marker
 *  left. A `QuoteMark` at/after the marker is the item's own CONTENT — e.g.
 *  `- > quote`, which Lezer parses `ListItem(ListMark, Blockquote(QuoteMark …))`
 *  with the mark AFTER `ListItem.from`. blockquote-reveal hides that inner `> `
 *  too, but it does NOT shift the `- ` marker, so subtracting it would wrongly
 *  under-hang the item (marker-flush) — see the `- > quote` regression test.
 *
 *  Returns 0 when the line carries no wrapping `QuoteMark`. Selection-agnostic:
 *  the caller passes 0 when the caret reveals the mark, so hang + reveal stay in
 *  lock-step (the F7-style contract the task-marker fold already keeps). */
export function blockquotePrefixCols(
  state: EditorState,
  tree: BuildContext["tree"],
  line: { from: number; to: number },
  markerFrom: number
): number {
  let cols = 0;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: (node) => {
      if (node.name === "QuoteMark" && node.from < markerFrom) {
        cols +=
          columnAt(state, absorbStructuralWhitespace(state, node.to)) - columnAt(state, node.from);
      }
    },
  });
  return cols;
}

/** True when a ViewUpdate must trigger a hang rebuild. Extracted from the
 *  inline update() condition so the SELECTION-aware trigger is pinnable
 *  deterministically (see listHangNeedsRebuild test — a mounted-view decoration
 *  read is flaky in happy-dom: no layout → non-deterministic visibleRanges;
 *  cf. cm-list-hang-integration.ts). The `selectionSet` clause is NEW — it
 *  reverses the Codex-F6 selection-independence so the blockquote hang tracks
 *  blockquote-reveal (which flips the `> ` on selection). Rebuilding
 *  unconditionally on selection matches the orchestrator (every inline reveal
 *  already rebuilds on selectionSet) and is bounded — buildListHangIndent walks
 *  visibleRanges only, O(items·depth) over the viewport, the same cost as any
 *  reveal rebuild. A per-doc "has a blockquoted list" pre-check would be
 *  premature (KISS): non-blockquote docs recompute an identical set, harmless
 *  at viewport scale. */
export function listHangNeedsRebuild(u: ViewUpdate): boolean {
  return (
    u.docChanged ||
    u.viewportChanged ||
    u.selectionSet ||
    syntaxTree(u.startState) !== syntaxTree(u.state) ||
    u.startState.facet(quollSyntaxExclusionZones) !== u.state.facet(quollSyntaxExclusionZones)
  );
}

export function buildListHangIndent(
  ctx: BuildContext,
  zones: readonly { from: number; to: number }[] = []
): DecorationSet {
  // Collect → de-dup by line → sort → build (mirrors taskCheckboxReveal). A
  // ListItem can be visited from more than one visible range (Lezer TOUCH
  // semantics), so `emitted` keeps each marker line's hang to one decoration.
  // We do NOT gate on `line.from >= range.from`: CodeMirror's visibleRanges can
  // begin mid-line when line-gap decorations split a very long wrapped line, so
  // a marker line whose start sits just before the range would be silently
  // dropped (Codex review #92) — leaving its soft-wrap continuations without a
  // hang. The final sort is what RangeSetBuilder's non-decreasing-`from`
  // contract needs: a line touched only by a later range (e.g. a multi-line
  // item, or that line-gap split) can otherwise surface a lower `from` after a
  // higher one.
  const emitted = new Set<number>();
  const out: Array<{ from: number; deco: Decoration }> = [];
  for (const range of ctx.visibleRanges) {
    ctx.tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (node.name !== "ListItem") {
          return;
        }
        const line = ctx.state.doc.lineAt(node.from);
        if (emitted.has(line.from)) {
          return;
        }
        if (pointInExclusionZone(line.from, zones)) {
          return;
        }
        // Caret ON the marker line → blockquote-reveal SHOWS the `> ` prefix, so the
        // hang must include it (pass 0). Caret OFF → the `> ` is replace-hidden, so
        // subtract its column width. Same predicate blockquote-reveal uses, so the
        // hang flips in lock-step with the reveal. NOTE: the ancestor-task-fold
        // reading-state glitch (above) is orthogonal — a blockquoted task-nested
        // child (`> - [ ] a` / `>   - b`) still carries the task-fold +MARKER/+step
        // re-base even though blockquote-reveal collapses the visual nesting; that
        // remains the deferred F6 limitation, NOT addressed by this blockquote fix.
        const revealed = intersectsAnySelection(ctx.selection, line.from, line.to);
        // markerFrom = the ListMark byte position (the geometry's marker anchor)
        // so blockquotePrefixCols counts only wrapping-prefix QuoteMarks, not an
        // inline blockquote in the item's own content (`- > quote`).
        const markerFrom = node.node.firstChild?.from ?? node.from;
        const hiddenCols = revealed
          ? 0
          : blockquotePrefixCols(ctx.state, ctx.tree, line, markerFrom);
        const hang = resolveListItemHang(ctx.state, node.node, hiddenCols);
        if (hang === null) {
          return;
        }
        emitted.add(line.from);
        out.push({
          from: line.from,
          deco: Decoration.line({
            class: "quoll-list-hang",
            attributes: {
              style: `text-indent:calc(-1 * (${hang.indent}));padding-inline-start:calc(${CM_LINE_PAD_START} + (${hang.pad}))`,
            },
          }),
        });
      },
    });
  }
  out.sort((a, b) => a.from - b.from);
  const builder = new RangeSetBuilder<Decoration>();
  for (const entry of out) {
    builder.add(entry.from, entry.from, entry.deco);
  }
  return builder.finish();
}

function toCtx(view: EditorView): BuildContext {
  return {
    state: view.state,
    selection: view.state.selection,
    visibleRanges: view.visibleRanges,
    tree: syntaxTree(view.state),
  };
}

/** Editor extension: a ViewPlugin holding the list hang-indent line
 *  decorations. Rebuilds on doc / viewport / parsed-tree / selection changes
 *  (via `listHangNeedsRebuild`). The `selectionSet` trigger is NEW — it
 *  reverses the Codex-F6 selection-independence so the blockquote hang tracks
 *  blockquote-reveal in lock-step. The ancestor-task-fold reading-state glitch
 *  (caret on an ancestor task reveals its raw `- [ ] `, but descendants still
 *  hang as if folded) remains a known F6 limitation — see the module header.
 *  Module-level const (stable identity) so `view.plugin(listHangIndent)`
 *  resolves in tests — mirrors `tableBlockField`. NOT annotated `: Extension`
 *  (that widens the type and breaks `view.plugin()`'s `ViewPlugin<T>`
 *  requirement); a ViewPlugin is structurally an Extension already. */
export const listHangIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildListHangIndent(
        toCtx(view),
        view.state.facet(quollSyntaxExclusionZones)
      );
    }
    update(u: ViewUpdate): void {
      if (listHangNeedsRebuild(u)) {
        this.decorations = buildListHangIndent(
          toCtx(u.view),
          u.view.state.facet(quollSyntaxExclusionZones)
        );
      }
    }
  },
  { decorations: (v) => v.decorations }
);
