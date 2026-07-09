// Heading vertical rhythm (Notion-style breathing room ABOVE headings).
//
// A viewport-scoped line decoration that adds a per-LEVEL `padding-top` to
// heading lines so documents read less cramped, matching Notion/Obsidian.
// `quollHighlightSpec` (theme.ts) already gives headings size/weight/colour;
// the vertical spacing above them relied entirely on blank source lines — this
// adds it as display-only layout instead. The `.quoll-list-hang` technique
// exactly (theme.ts CSS rule + a ViewPlugin that tags the line with a class):
// padding on the `.cm-line` (not margin) keeps CM's line-geometry / click→caret
// math accurate — CM sizes the line box INCLUDING padding, so posAtCoords treats
// the padding as the top of that line's clickable band (Codex-confirmed safe).
//
// Class-based, NOT inline style: the value is per-LEVEL and static, so a CSS
// class + theme rule (mirrors bulletMarkerThemeSpec / block-style) is the
// idiomatic fit — unlike `.quoll-list-hang`'s per-ITEM computed inline geometry.
// The decoration carries only `class: "quoll-heading-rhythm-<n>"`.
//
// Selection-INDEPENDENT: the space stays whether or not the caret is on the
// heading (the key difference from listHangNeedsRebuild — no `selectionSet`
// trigger; pinned by a revert-check).
//
// This is HALF of shipping heading rhythm correctly — the fold-gutter half
// (cm/fold/index.ts's headingRhythmFoldGutterLineClass) tags the SAME lines'
// gutter elements with the SAME padding so the fold chevron stays aligned. Both
// halves share ONE eligibility predicate (headingRhythmLevel below) so they can
// never drift — exactly as `.quoll-list-hang` ships with `quoll-fold-list-marker`
// (now a CONDITIONAL pairing: both sides gate on the same listItemGetsVerticalGap
// predicate, so only gap-worthy list lines carry either class — tight consecutive
// siblings carry neither — but the two still can never drift out of lock-step).

import { syntaxTree } from "@codemirror/language";
import { type EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import { isNascentLoneSetextHeading } from "../markdown.js";
import { quollSyntaxExclusionZones } from "./orchestrator.js";
import { pointInExclusionZone } from "./shared.js";
import type { BuildContext } from "./types.js";

// A Lezer node reference as handed to `tree.iterate`'s enter callback, derived
// from the iterate signature rather than imported from @lezer/common (a direct
// dep as of PR #66, derived rather than imported to avoid widening the
// direct-dep import surface — the same alias strategy types.ts uses for
// `Tree`). `.node` yields the full SyntaxNode (for `.parent`), and `.name` /
// `.from` are read directly.
type Tree = BuildContext["tree"];
type NodeRef = Parameters<NonNullable<Parameters<Tree["iterate"]>[0]["enter"]>>[0];

/** ATX (`# …`) and Setext (`…\n===`) headings, levels 1-6. Same shape as
 *  fold/index.ts's HEADING_NODE but widened to `[1-6]` — rhythm covers every
 *  level, not just the H1-3 that inflate the gutter row. quollHighlightSpec
 *  styles Setext headings too (via the heading1/2 tags), and Setext only reaches
 *  level 2, so the `[3-6]` alternatives are ATX-only in practice. */
export const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-6])$/;

/** The shared eligibility predicate: returns the heading's level (1-6) for a
 *  rhythm-eligible heading, else `null`. Used by BOTH the content ViewPlugin
 *  (below) and the fold-gutter StateField (cm/fold/index.ts) so the two halves
 *  cannot drift. Applies the locked design decisions in order:
 *   1. Level match — non-headings (and a malformed level) drop out.
 *   1b. Nascent lone setext — a lone-`-`/`=` underline reads as a bullet list in
 *      progress, not a heading (isNascentLoneSetextHeading, markdown.ts). Its
 *      FONT is already demoted (setext-nascent-reveal.ts); suppress rhythm padding
 *      + the fold-gutter row in lock-step so the paragraph keeps no heading
 *      spacing affordance. Multi-char `---`/`===` stay real headings.
 *   2. TOP-LEVEL only — emit only when the heading's parent is the tree's top
 *      (Document) node. NodeType singletons compare stably, so this is more
 *      future-proof than the string "Document" and avoids the on-demand
 *      SyntaxNode-identity trap of comparing against `tree.topNode` directly. A
 *      heading nested in a blockquote / callout (`> # x` parses as
 *      `Blockquote > ATXHeading1`) already gets breathing room from the panel's
 *      `-open` padding-y; our padding-top there would double-pad and fight the
 *      block-panel corner.
 *   3. FIRST-LINE suppression — a heading on physical line 1 hugs the top edge
 *      (Notion adds space BETWEEN blocks, not above the first). This is a
 *      PHYSICAL line-1 test: a heading that is the first BODY block after a
 *      collapsed frontmatter block is NOT line 1 → it correctly gets rhythm (the
 *      frontmatter block sits above it). No "first non-frontmatter block" logic
 *      is needed — the physical test gives the right result in every real case.
 *   4. Exclusion zones — a YAML frontmatter body line like `title: x` followed
 *      by `---` parses under plain Lezer as a SetextHeading2 sitting DIRECTLY
 *      under Document, so without zone filtering rhythm padding would land inside
 *      the frontmatter block that frontmatterBlockField conceals. Honour the
 *      same `quollSyntaxExclusionZones` the list code guards against ("YAML lists
 *      parse as markdown but get no hang").
 *
 *  Padding rides `lineAt(node.from)` = the heading's FIRST text line; for a
 *  multi-line Setext heading that is the first paragraph line, NOT the `===`/`---`
 *  underline. */
export function headingRhythmLevel(
  state: EditorState,
  tree: Tree,
  node: NodeRef,
  zones: readonly { from: number; to: number }[]
): number | null {
  const m = HEADING_NODE.exec(node.name);
  if (!m) {
    return null;
  }
  if (isNascentLoneSetextHeading(node.node)) {
    return null; // lone-`-`/`=` nascent list — no rhythm padding / fold-gutter row
  }
  const level = Number(m[1]); // 1..6 by the regex
  if (node.node.parent?.type !== tree.topNode.type) {
    return null; // top-level only (parent is Document)
  }
  const line = state.doc.lineAt(node.from);
  if (line.number === 1) {
    return null; // first physical line hugs the top edge
  }
  if (pointInExclusionZone(line.from, zones)) {
    return null; // frontmatter etc.
  }
  return level;
}

/** True when a ViewUpdate must trigger a rhythm rebuild. Extracted + exported so
 *  the SELECTION-INDEPENDENCE can be pinned deterministically (a mounted-view
 *  decoration read is flaky in happy-dom: no layout → non-deterministic
 *  visibleRanges — see listHangNeedsRebuild). Rebuilds on doc / viewport /
 *  parsed-tree / exclusion-zone-facet change ONLY — deliberately NO
 *  `selectionSet` (the rhythm space is the same whether or not the caret is on
 *  the heading; adding `u.selectionSet ||` reds the revert-check). */
export function headingRhythmNeedsRebuild(u: ViewUpdate): boolean {
  return (
    u.docChanged ||
    u.viewportChanged ||
    syntaxTree(u.startState) !== syntaxTree(u.state) ||
    u.startState.facet(quollSyntaxExclusionZones) !== u.state.facet(quollSyntaxExclusionZones)
  );
}

export function buildHeadingRhythm(
  ctx: BuildContext,
  zones: readonly { from: number; to: number }[] = []
): DecorationSet {
  // Collect → de-dup by line → sort → build (mirrors buildListHangIndent). A
  // heading node can be visited from more than one visible range (Lezer TOUCH
  // semantics), so `emitted` keeps each heading line's rhythm to one decoration.
  // We do NOT gate on `line.from >= range.from`: CodeMirror's visibleRanges can
  // begin mid-line when line-gap decorations split a very long wrapped line, so a
  // heading line whose start sits just before the range would be silently
  // dropped. The final sort is what RangeSetBuilder's non-decreasing-`from`
  // contract needs: a line touched only by a later range can otherwise surface a
  // lower `from` after a higher one.
  const emitted = new Set<number>();
  const out: Array<{ from: number; deco: Decoration }> = [];
  for (const range of ctx.visibleRanges) {
    ctx.tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const level = headingRhythmLevel(ctx.state, ctx.tree, node, zones);
        if (level === null) {
          return;
        }
        const line = ctx.state.doc.lineAt(node.from);
        // Half-open viewport-overlap guard (mirrors heading-reveal.ts's
        // `markFrom < range.to && range.from < markTo`). Lezer's
        // tree.iterate({from,to}) uses TOUCH semantics, so a heading whose line
        // starts EXACTLY at range.to — the first offset PAST the drawn range —
        // is still entered. Emitting a layout-changing line decoration for a
        // line outside the drawn viewport violates the viewport-scoped
        // contract. The `range.from < line.to` half deliberately KEEPS a line
        // whose start precedes a mid-line range boundary (CM can begin a
        // visibleRange mid-line when a line-gap splits a long wrapped line),
        // consistent with the "do NOT gate on line.from >= range.from" note
        // above — so soft-wrap continuations of a heading that straddles the
        // range start are not dropped.
        if (!(line.from < range.to && range.from < line.to)) {
          return;
        }
        if (emitted.has(line.from)) {
          return;
        }
        emitted.add(line.from);
        out.push({
          from: line.from,
          deco: Decoration.line({ class: `quoll-heading-rhythm-${level}` }),
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

/** Editor extension: a ViewPlugin holding the per-level heading padding-top line
 *  decorations. Rebuilds on doc / viewport / parsed-tree / exclusion-zone-facet
 *  changes (via `headingRhythmNeedsRebuild`) — NOT selection: the space is
 *  selection-independent. Standalone (not folded into quollSyntaxReveal, which
 *  arbitrates INLINE reveals vs block zones; this is line-only), exactly like
 *  listHangIndent. Reads `view.state.facet(quollSyntaxExclusionZones)` in create
 *  + update. Module-level const (stable identity) so `view.plugin(headingRhythm)`
 *  resolves in tests; a ViewPlugin is structurally an Extension already, so it is
 *  NOT annotated `: Extension` (which would break `view.plugin()`'s ViewPlugin<T>
 *  requirement). */
export const headingRhythm = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildHeadingRhythm(
        toCtx(view),
        view.state.facet(quollSyntaxExclusionZones)
      );
    }
    update(u: ViewUpdate): void {
      if (headingRhythmNeedsRebuild(u)) {
        this.decorations = buildHeadingRhythm(
          toCtx(u.view),
          u.view.state.facet(quollSyntaxExclusionZones)
        );
      }
    }
  },
  { decorations: (v) => v.decorations }
);
