// Fenced-code panel + blockquote left-rule line styling. Quoll is
// text-canonical CodeMirror — there is no rendered <pre> / <blockquote>
// element to select, so each LINE of the block carries a Decoration.line
// marker class and the panel/rule is
// assembled from the stacked .cm-line backgrounds. Decoration-only: never
// mutates the document, so the bytes round-trip identically.
//
// SELECTION-DEPENDENT for the fenced-code panel edges — and CONDITIONALLY so
// for the blockquote rule, which now ALSO migrates its rounded -open / -close
// off a concealed boundary fence onto the adjacent visible body line (via the
// same-file block-scoped predicate the fenced panel calls — parity is now
// structural, not just a comment; see below), mirroring the fenced panel.
// A concealed fence row gets the zero-height
// `quoll-fenced-code-fence-hidden` class instead of the panel background, and
// the rounded-corner + 0.75em vertical-padding edge (-open / -close) MOVES
// onto the adjacent first / last VISIBLE (body) line — so no blank padded row
// is left where the fence used to render.
//
// fenced-code-reveal.ts conceals each ``` fence MARK, and this module collapses the
// fence ROW, under the SAME predicate: fencedCodeBlockRevealed (fenced-code-body.ts) —
// the caret intersecting the FencedCode node's full line span. A caret anywhere in
// the block reveals BOTH fences (mark shown + row kept); leaving the block conceals
// both. For a fence WITH A BODY the two surfaces move under one predicate and cannot
// disagree about which fence rows are hidden (parity is load-bearing — do NOT
// re-inline a per-line selection test on a fence line). A BODYLESS fence is the
// deliberate exception (Codex #3): this module never collapses its row (it keeps the
// legacy always-visible small panel so an empty block does not vanish), while its
// marks still toggle with the predicate — an intentional scope difference, not a
// desync.
// The two ship as SEPARATE ViewPlugins so a caret move re-walks only the fenced
// pass in the COMMON case: `blockquoteRule` caches a `hasConcealableBoundaryFence`
// flag (selection-INDEPENDENT — recomputed only on the structural rebuild) and
// adds `selectionSet` to its rebuild triggers ONLY when that flag is set, so a
// document with NO blockquote-boundary fence keeps the split's caret-hot-path
// optimization (no blockquote re-walk on a caret move); `fencedCodePanel` is
// unconditionally selection-AWARE (keeps the `selectionSet` trigger, matching
// the orchestrator's per-caret rebuild cadence). CodeMirror unions their
// `Decoration.line` classes on a shared line, so a nested `> ```…` ` line still
// gets both — and BOTH must stay registered (via the `blockStyle` aggregate in
// editor.ts).
//
// Parity boundary is LINE-granular by design: fenced-code-reveal guards each
// fence MARK on `mark ∩ visibleRange` while this module collapses on
// `line ∩ visibleRange`. They can only disagree when a visible-range boundary
// falls strictly between a fence mark's end and its line end — which needs
// CodeMirror to virtualize a fence line thousands of chars long (a degenerate
// info-string). The consequence is purely cosmetic; guarding it would add
// complexity for a non-realistic input (KISS).
//
// The blockquote rule's -open / -close land on the node's FIRST / LAST line
// (computed from the NODE span via lineAt(node.from / node.to - 1), NOT the
// viewport-clamped range) so the rounded corners + top/bottom padding sit
// only on the block edges even when the block is scrolled half-off-screen —
// EXCEPT when that first / last line is a CONCEALED boundary fence, in which
// case the edge migrates one line inward onto the adjacent visible body line
// (the boundary-fence exception; see buildBlockquoteRuleWithBoundaryInfo).
//
// Nested constructs compose: each line accumulates the UNION of every styled
// node covering it (see buildBlockStyle), so a fenced block inside a quote
// (`> ```…`) shows BOTH the quote rule and the fenced-code panel, and a `> >`
// nested quote's inner node still contributes its own open/close edges.
//
// Nested quotes also read as a DEEPER tint: each quote line carries a
// `quoll-blockquote-depth-{2,3}` class (blockquoteDepthClass) keyed to its
// leading `>` count, so cm/theme.ts paints a progressively deeper fill on
// `> >` / `> > >` lines. Depth is the per-line `>` count (parity with
// blockquote-reveal's per-line mark hide) — NOT the ancestor-Blockquote nesting
// — so a `> c` continuation of a deeper quote reads at its own literal depth and
// a lazy-continuation line (no `>`) keeps the base depth-1 tint.
//
// An OUTERMOST blockquote whose FIRST line is a `[!TYPE]` admonition marker
// (GitHub/Obsidian: NOTE/TIP/IMPORTANT/WARNING/CAUTION, with an optional
// Obsidian `-`/`+` fold suffix) additionally carries `quoll-callout` +
// `quoll-callout-{type}` on every line, so cm/theme.ts can paint a per-type accent
// bar + tint. The classification is single-sourced in callout.ts (block-style +
// the callout-marker-conceal StateField both import it). Scoped to the outermost
// quote (calloutTypeForOutermost) so a nested `> >` inner marker never double-emits
// a second type class — the container type wins. When the caret is INSIDE the block
// the `[!TYPE]` marker row is REVEALED and gets `quoll-callout-marker` (header
// weight); when OUTSIDE, the marker StateField conceals the whole row and this
// module migrates the rounded `-open` corner onto the first
// VISIBLE body line via the same-source `calloutMarkerConceal` predicate. The
// `[!TYPE]` marker stays literal editable text (decoration-only, byte-identical
// round-trip); an unrecognised token (`[!FOO]`) matches nothing → generic panel.
//
// We paint EVERY line of the Blockquote node span — including CommonMark
// lazy-continuation lines that carry no leading `>` (Lezer folds them into
// the same Blockquote node). This matches Markdown Studio painting the whole
// `<blockquote>` element, so a wrapped quote keeps a continuous rule. The
// `>` token reveal/hide is the separate concern of blockquote-reveal.ts.
//
// Only block REPLACE decorations (widgets) are forbidden from a ViewPlugin
// (CM rejects them at runtime → they ship as StateFields). Decoration.LINE
// decorations ARE legal from a ViewPlugin (list-hang-indent does the same),
// so these ship as TWO standalone ViewPlugins: `blockquoteRule` keyed to doc /
// viewport / parsed-tree / exclusion-zone changes (PLUS selectionSet only when
// its cached boundary-fence flag is set), and `fencedCodePanel` keyed to those
// PLUS selectionSet unconditionally. Tradeoff: a
// doc/viewport/tree change now walks the tree twice (once per pass) where the
// combined plugin walked once — negligible (bounded visible-range iterate over
// an already-parsed tree), and the caret-move hot path now walks only the
// fenced pass.
//
// Exclusion: reads only `quollSyntaxExclusionZones` (parity with
// list-hang-indent), not `quollBlockReplaceZones`. Fenced-code / blockquote
// constructs are never themselves widgetised (tables / images / frontmatter
// are), so the block-replace facet cannot intersect them. Two modules
// contribute to quollSyntaxExclusionZones: frontmatter-field (its span is
// `---`-fenced, so it never parses as FencedCode / Blockquote — this gate is
// indeed cheap insurance for it) and callout-marker-conceal (concealed `[!TYPE]`
// rows ARE Blockquote syntax — the point-exclusion here is load-bearing: it skips
// the concealed row and migrates the rounded `-open` corner to the first visible
// body line; see callout-marker-conceal.ts:7-13). A shared union helper
// (Codex Conf 86) is deferred — it would also touch list-hang-indent, out of
// this PR's 1-purpose scope.
//
// Known limitation (deferred — rare, and the fix is out of this module's scope):
//   - Blockquote-nested list (`> - item`): list-hang-indent's INLINE
//     padding-inline-start outranks this module's themed `padding-left`, so
//     the quote's 1em text inset yields to the list hang geometry on those
//     lines (the left RULE still paints). Same known-limitation class as
//     list-hang-indent's own blockquote note (Codex Conf 90).
//
// Styling lives in cm/theme.ts (quollBlockStyleTheme, an EditorView.theme),
// NOT styles.css: CodeMirror's base theme sets `.cm-line { padding: 0 2px 0
// 6px }` as an UNLAYERED <style> that beats every layered styles.css rule,
// so the line padding can only be overridden by another unlayered,
// editor-scoped CM theme. Token colours stay owned by quollHighlight.

import { syntaxTree } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";

import {
  fencedCodeBlockRevealed,
  fencedCodeFenceLandmarks,
} from "../fenced-code/fenced-code-body.js";
import { toCtx } from "./build-context.js";
import {
  CALLOUT_CLASS,
  CALLOUT_MARKER_CLASS,
  calloutClassForType,
  calloutMarkerConceal,
  calloutTypeForOutermost,
} from "./callout.js";
import { quollSyntaxExclusionZones } from "./orchestrator.js";
import { pointInExclusionZone } from "./shared.js";
import type { BuildContext } from "./types.js";

/** Persistent Lezer node type — the `.node` of an iterate cursor. Derived from
 *  syntaxTree's return type rather than imported so the direct-dep surface stays
 *  narrow (@lezer/common is a direct dep as of PR #66; parity with
 *  fenced-code-body.ts / types.ts). */
type SyntaxNode = ReturnType<typeof syntaxTree>["topNode"];

/** Marker classes attached to each line of a fenced-code block. The theme
 *  selectors in cm/theme.ts (`.cm-line.quoll-fenced-code…`) are the
 *  consumers — renaming requires updating both in lockstep. */
export const FENCED_CODE_CLASS = "quoll-fenced-code";
export const FENCED_CODE_OPEN_CLASS = "quoll-fenced-code-open";
export const FENCED_CODE_CLOSE_CLASS = "quoll-fenced-code-close";
/** Class for a CONCEALED fence row (caret off it → fenced-code-reveal has
 *  replaced its ``` with empty DOM). The theme collapses it to zero height so
 *  no blank padded row remains; the panel edge moves to the adjacent body
 *  line. Consumed by cm/theme.ts `.cm-line.quoll-fenced-code-fence-hidden`. */
export const FENCED_CODE_FENCE_HIDDEN_CLASS = "quoll-fenced-code-fence-hidden";

/** Marker classes attached to each line of a blockquote. */
export const BLOCKQUOTE_CLASS = "quoll-blockquote";
export const BLOCKQUOTE_OPEN_CLASS = "quoll-blockquote-open";
export const BLOCKQUOTE_CLOSE_CLASS = "quoll-blockquote-close";

/** Deepest nesting level that gets its own deeper-tint class. Level 1 (a single
 *  `>`) uses the base BLOCKQUOTE_CLASS fill; levels 2+ add
 *  `quoll-blockquote-depth-{2,3}` so cm/theme.ts can paint a progressively
 *  deeper fill. Capped here (deeper quotes reuse `-3`) so the CSS set stays
 *  finite and testable — the extra contrast plateaus and `> > > >` quotes are
 *  vanishingly rare. */
export const BLOCKQUOTE_MAX_DEPTH = 3;

/** Deeper-tint class for a line carrying `count` leading `>` marks, or `null`
 *  when the line is not nested (level ≤ 1 → base tint only). The depth is the
 *  per-line `>` count — the same per-line basis blockquote-reveal hides marks on
 *  — so a lazy-continuation line (0 marks, still painted as depth-1 quote) keeps
 *  the base tint, and a `> c` continuation of a deeper quote reads at its own
 *  literal `>` depth, matching what the author typed. */
export function blockquoteDepthClass(count: number): string | null {
  if (count < 2) {
    return null;
  }
  return `quoll-blockquote-depth-${Math.min(count, BLOCKQUOTE_MAX_DEPTH)}`;
}

/** Per-FencedCode-node geometry the line-class helper needs. Line numbers are
 *  1-based (CodeMirror `doc.line` convention). */
type FencedLandmarks = {
  openFenceLine: number;
  /** 1-based close-fence line, or null for an unclosed block (one CodeMark). */
  closeFenceLine: number | null;
  /** First/last BODY line (between the fences), or null when the block has no
   *  body (e.g. ```` ```\n``` ````). */
  firstBodyLine: number | null;
  lastBodyLine: number | null;
  /** Caret is NOT on the open fence line (so it is concealed → collapse it and
   *  move the -open edge to the first body line). Only ever true with a body. */
  openConcealed: boolean;
  /** Same for the closing fence (closed blocks with a body only). */
  closeConcealed: boolean;
};

/** Class list for line `n` of a FencedCode node. The panel edge (-open/-close,
 *  i.e. the rounded corner + 0.75em vertical padding) sits on the fence line
 *  when that fence is REVEALED (caret on it) and on the adjacent BODY line when
 *  the fence is concealed; a concealed fence row gets the zero-height hidden
 *  class instead of the panel background, so no blank padded row remains. */
export function fencedCodeLineClasses(n: number, L: FencedLandmarks): string[] {
  // Bodyless block (e.g. ```` ```\n``` ````): there is NO body line to host the
  // panel edges. DELIBERATE design decision (Codex #3): keep the legacy
  // fence-line panel rather than collapse. fenced-code-reveal still conceals the
  // fence marks, so an empty block shows a minimal (small, empty) rounded panel —
  // signalling "an empty code block is here". Collapsing both fences would make
  // the empty block VANISH entirely, which is worse UX than a small placeholder
  // panel. The "no blank row" goal targets blocks WITH a body; document this
  // exception in the PR. A single-line block is its own open AND close.
  if (L.firstBodyLine === null) {
    const out = [FENCED_CODE_CLASS];
    if (n === L.openFenceLine) {
      out.push(FENCED_CODE_OPEN_CLASS);
    }
    if (n === (L.closeFenceLine ?? L.openFenceLine)) {
      out.push(FENCED_CODE_CLOSE_CLASS);
    }
    return out;
  }
  if (n === L.openFenceLine) {
    return L.openConcealed
      ? [FENCED_CODE_FENCE_HIDDEN_CLASS]
      : [FENCED_CODE_CLASS, FENCED_CODE_OPEN_CLASS];
  }
  if (L.closeFenceLine !== null && n === L.closeFenceLine) {
    return L.closeConcealed
      ? [FENCED_CODE_FENCE_HIDDEN_CLASS]
      : [FENCED_CODE_CLASS, FENCED_CODE_CLOSE_CLASS];
  }
  // Body lines. `lastBodyLine` is non-null whenever `firstBodyLine` is (they are
  // set together from the body span); the explicit guard satisfies the compiler.
  if (L.lastBodyLine !== null && n >= L.firstBodyLine && n <= L.lastBodyLine) {
    const out = [FENCED_CODE_CLASS];
    if (L.openConcealed && n === L.firstBodyLine) {
      out.push(FENCED_CODE_OPEN_CLASS);
    }
    if (n === L.lastBodyLine) {
      // Closed block: the body edge takes -close only when the close fence is
      // concealed (collapsed). Unclosed: there is no close fence, so the last
      // body line is always the bottom edge.
      if (L.closeFenceLine === null || L.closeConcealed) {
        out.push(FENCED_CODE_CLOSE_CLASS);
      }
    }
    return out;
  }
  return [];
}

/** The node ref passed to `tree.iterate`'s `enter`, derived from the shared
 *  `BuildContext["tree"]` type so the direct-dep import surface stays narrow
 *  (@lezer/common is a direct dep as of PR #66, derived rather than imported —
 *  see types.ts) and the node type tracks the exact tree the helper iterates. */
type IterateNode = Parameters<
  NonNullable<Parameters<BuildContext["tree"]["iterate"]>[0]["enter"]>
>[0];

/** Shared skeleton for the two block line-decoration builders. Walks every
 *  visible range, asks `classify` to map a node to its span + per-line classes,
 *  unions the classes per line (nested same-type nodes + multi-range overlap),
 *  and emits one Decoration.line per styled line. This is the EXACT machinery
 *  of the pre-split single walk (clamp / exclusion / byLine Set union / sorted
 *  build) — the only structural change is that the fenced and blockquote passes
 *  now run as two separate ViewPlugins (different rebuild triggers), so a caret
 *  move re-walks only the fenced pass. (This 2-way helper is born from THIS
 *  split; it is NOT the deferred 3-way union helper that would also fold in
 *  list-hang-indent — Codex Conf 86 — which stays out of scope.) */
function buildBlockLineDecorations(
  ctx: BuildContext,
  zones: readonly { from: number; to: number }[],
  classify: (
    node: IterateNode
  ) => { from: number; to: number; classesForLine: (lineNumber: number) => string[] } | null
): DecorationSet {
  const doc = ctx.state.doc;
  const byLine = new Map<number, Set<string>>();
  for (const range of ctx.visibleRanges) {
    const emitNodeLines = (
      nodeFrom: number,
      nodeTo: number,
      classesForLine: (lineNumber: number) => string[]
    ): void => {
      const clampFrom = Math.max(nodeFrom, range.from);
      const clampTo = Math.min(nodeTo, range.to);
      if (clampFrom >= clampTo) {
        return;
      }
      const fromLine = doc.lineAt(clampFrom).number;
      const toLine = doc.lineAt(clampTo - 1).number;
      for (let n = fromLine; n <= toLine; n++) {
        const line = doc.line(n);
        if (pointInExclusionZone(line.from, zones)) {
          continue;
        }
        const classes = classesForLine(n);
        if (classes.length === 0) {
          continue;
        }
        let set = byLine.get(line.from);
        if (set === undefined) {
          set = new Set<string>();
          byLine.set(line.from, set);
        }
        for (const c of classes) {
          set.add(c);
        }
      }
    };
    ctx.tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const r = classify(node);
        if (r === null) {
          return;
        }
        emitNodeLines(r.from, r.to, r.classesForLine);
      },
    });
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const [from, set] of [...byLine.entries()].sort(([a], [b]) => a - b)) {
    builder.add(from, from, Decoration.line({ class: [...set].join(" ") }));
  }
  return builder.finish();
}

/** 1-based fence line → its FencedCode node, for every FencedCode WITH A BODY in
 *  the visible ranges. Selection-INDEPENDENT (which lines are *concealable*, keyed
 *  to the node so the caller can run the block-scoped reveal check). The blockquote
 *  rule consults this so its rounded -open/-close edge migrates off a concealed
 *  boundary fence onto the adjacent visible body line, exactly as buildFencedCodePanel
 *  migrates its own edges. Bodyless fences are EXCLUDED (they keep the legacy visible
 *  panel, never collapse). A range-STRADDLING FencedCode is still picked up
 *  (tree.iterate enters any overlapping node; landmarks come from the FULL node span). */
function concealableFenceNodes(ctx: BuildContext): Map<number, SyntaxNode> {
  const doc = ctx.state.doc;
  const map = new Map<number, SyntaxNode>();
  for (const range of ctx.visibleRanges) {
    ctx.tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        if (node.name !== "FencedCode") {
          return;
        }
        const { openFenceLine, closeFenceLine, bodyStartLine } = fencedCodeFenceLandmarks(
          doc,
          node.node
        );
        if (bodyStartLine === null) {
          return; // bodyless: fences stay visible, never concealable
        }
        map.set(openFenceLine, node.node);
        if (closeFenceLine !== null) {
          map.set(closeFenceLine, node.node);
        }
      },
    });
  }
  return map;
}

/** 1-based line number → count of leading `>` marks on that line, over the
 *  visible ranges. Drives the nested deeper-tint class (blockquoteDepthClass).
 *  Walks QuoteMark nodes directly (parity with blockquote-reveal), de-duping by
 *  position so a mark at a shared visible-range boundary — visited in BOTH
 *  adjacent ranges under Lezer's TOUCH semantics — is counted once. A line with
 *  no QuoteMark (a lazy-continuation line folded into the Blockquote node) is
 *  simply absent from the map → the base depth-1 tint. */
function quoteMarkCountByLine(ctx: BuildContext): Map<number, number> {
  const doc = ctx.state.doc;
  const counts = new Map<number, number>();
  const seen = new Set<number>();
  for (const range of ctx.visibleRanges) {
    if (range.from >= range.to) {
      continue;
    }
    // Snap the walked window to WHOLE lines so it matches the line-clamped span
    // emitNodeLines actually paints. A visible range can start mid-line (CodeMirror
    // line-gap-splits a very long wrapped line — see list-hang-indent's Codex #92),
    // and a nested line's leading `>` marks then sit BEFORE range.from; walking the
    // raw range would miss them and undercount the depth on a line that is still
    // painted (its depth class would silently drop). The `seen` Set absorbs the
    // extra duplicate visits that line-snapping adjacent/overlapping ranges creates.
    const from = doc.lineAt(range.from).from;
    const to = doc.lineAt(range.to - 1).to;
    ctx.tree.iterate({
      from,
      to,
      enter: (node) => {
        if (node.name !== "QuoteMark" || seen.has(node.from)) {
          return;
        }
        seen.add(node.from);
        const lineNumber = doc.lineAt(node.from).number;
        counts.set(lineNumber, (counts.get(lineNumber) ?? 0) + 1);
      },
    });
  }
  return counts;
}

/** Blockquote left-rule line decorations PLUS whether any blockquote has a
 *  concealable fence at a boundary (the flag the ViewPlugin caches to gate its
 *  conditional selectionSet rebuild). Edge migration: when a blockquote's first
 *  or last line is a CONCEALED fence (collapsed to zero height), the rounded
 *  -open/-close rides the adjacent VISIBLE body line instead of the invisible
 *  fence row — mirroring buildFencedCodePanel's own -open/-close migration. The
 *  concealment predicate is the SHARED block-scoped `fencedCodeBlockRevealed` that
 *  buildFencedCodePanel also uses, so the two edge migrations can never disagree
 *  about which fence rows are hidden. Module-private (Conf 86): only the
 *  same-module blockquoteRule ViewPlugin and the buildBlockquoteRule wrapper
 *  call it. */
function buildBlockquoteRuleWithBoundaryInfo(
  ctx: BuildContext,
  zones: readonly { from: number; to: number }[] = []
): { decorations: DecorationSet; hasConcealableBoundaryFence: boolean } {
  const doc = ctx.state.doc;
  const concealable = concealableFenceNodes(ctx);
  // Per-line `>` count → the nested deeper-tint class. Computed once here (the
  // classify closure below reads it per line); a nested `> > b` line resolves to
  // depth 2 whether the outer or inner Blockquote node is the one visiting it, so
  // the byLine Set union in buildBlockLineDecorations dedupes to one depth class.
  const quoteCounts = quoteMarkCountByLine(ctx);
  // A concealable boundary fence is CONCEALED (collapsed) exactly when the caret is
  // OUTSIDE its whole block — the shared block-scoped predicate (parity with the panel).
  const isConcealed = (line1based: number): boolean => {
    const node = concealable.get(line1based);
    return node !== undefined && !fencedCodeBlockRevealed(doc, ctx.selection, node);
  };
  let hasConcealableBoundaryFence = false;
  const decorations = buildBlockLineDecorations(ctx, zones, (node) => {
    if (node.name !== "Blockquote") {
      return null;
    }
    // `node.to` is half-open (position AFTER the last byte), so `node.to - 1`
    // resolves to the last CONTENT line even if a future Lezer makes node.to a
    // trailing-newline boundary (Codex Conf 92).
    const nodeFirstLine = doc.lineAt(node.from).number;
    const nodeLastLine = doc.lineAt(node.to - 1).number;
    if (concealable.has(nodeFirstLine) || concealable.has(nodeLastLine)) {
      hasConcealableBoundaryFence = true;
    }
    // Callout admonition: an OUTERMOST blockquote whose `[!TYPE]` first line selects
    // a per-type accent + icon. Scoped to the outermost quote (a nested `> >` inner
    // node returns null via calloutTypeForOutermost) so a line never gets two
    // conflicting type classes — the container's type wins by construction. null
    // (unknown / plain / nested-inner) → no callout class → the generic Phase-1 panel.
    const calloutType = calloutTypeForOutermost(doc, node.node);
    // When the caret is OUTSIDE the callout, the marker StateField conceals the
    // `[!TYPE]` row (collapsed to zero height, whole line published to the exclusion
    // facet). `markerConcealed` is derived from the SAME single-source predicate the
    // StateField uses, on the SAME state, so the two can never disagree.
    const markerConcealed = calloutMarkerConceal(doc, ctx.selection, node.node) !== null;
    // Migrate the rounded edge off a concealed boundary fence OR a concealed callout
    // marker onto the adjacent visible line. Start one line inward when the marker
    // is concealed (it collapses to zero height), then walk past any remaining
    // concealed rows — a concealed LEADING fence collapses too (the callout body
    // starts with a fenced block; caret outside the callout ⇒ outside the fence), so
    // the visible top edge is the first non-concealed body line. This subsumes the
    // fence-only single step: for a non-callout with a concealed open fence
    // `markerConcealed` is false → start at nodeFirstLine, then the loop steps once
    // (identical to the previous single check). closeLine is UNCHANGED.
    //
    // No `hasConcealableMarker` gate is added on blockquoteRule for this: the callout
    // conceal is FACET-PUBLISHED, so blockquoteRule's `structural` trigger already
    // rebuilds on the exclusion-facet identity change that a conceal↔reveal flip
    // produces (R2). Contrast the fence case, whose conceal is NOT facet-published →
    // it genuinely needs the explicit `hasBoundaryFence` selectionSet gate.
    let openLine = markerConcealed ? nodeFirstLine + 1 : nodeFirstLine;
    while (openLine < nodeLastLine && isConcealed(openLine)) {
      openLine += 1;
    }
    const closeLine = isConcealed(nodeLastLine) ? nodeLastLine - 1 : nodeLastLine;
    return {
      from: node.from,
      to: node.to,
      classesForLine: (n) => {
        const out = [BLOCKQUOTE_CLASS];
        const depthClass = blockquoteDepthClass(quoteCounts.get(n) ?? 0);
        if (depthClass !== null) {
          out.push(depthClass);
        }
        if (n === openLine) {
          out.push(BLOCKQUOTE_OPEN_CLASS);
        }
        if (n === closeLine) {
          out.push(BLOCKQUOTE_CLOSE_CLASS);
        }
        if (calloutType !== null) {
          out.push(CALLOUT_CLASS, calloutClassForType(calloutType));
          // The concealed marker line is skipped by buildBlockLineDecorations
          // (facet-excluded), so this only fires on a REVEALED marker row — the
          // `!markerConcealed` guard keeps the header class off the migrated row.
          if (n === nodeFirstLine && !markerConcealed) {
            out.push(CALLOUT_MARKER_CLASS);
          }
        }
        return out;
      },
    };
  });
  return { decorations, hasConcealableBoundaryFence };
}

/** Blockquote left-rule line decorations. Thin projection of
 *  {@link buildBlockquoteRuleWithBoundaryInfo} for the direct-call consumers
 *  (editor.ts wiring test + block-style tests). See that function for the
 *  edge-migration + concealment-parity contract. */
export function buildBlockquoteRule(
  ctx: BuildContext,
  zones: readonly { from: number; to: number }[] = []
): DecorationSet {
  return buildBlockquoteRuleWithBoundaryInfo(ctx, zones).decorations;
}

/** Fenced-code panel line decorations. Selection-AWARE: fenced-code-reveal
 *  conceals both ``` fences when the caret is OUTSIDE the block, and this builder
 *  moves the panel edge (-open/-close) onto the adjacent body line + collapses the
 *  concealed fence rows to the zero-height hidden class. The reveal predicate is
 *  the SAME block-scoped `fencedCodeBlockRevealed` fenced-code-reveal uses (predicate
 *  parity is load-bearing — keep them identical), so `fencedCodePanel` KEEPS
 *  `selectionSet` in its rebuild triggers. */
export function buildFencedCodePanel(
  ctx: BuildContext,
  zones: readonly { from: number; to: number }[] = []
): DecorationSet {
  const doc = ctx.state.doc;
  return buildBlockLineDecorations(ctx, zones, (node) => {
    if (node.name !== "FencedCode") {
      return null;
    }
    const sn = node.node;
    // All fence/body geometry comes from the single-sourced CodeMark walk in
    // fenced-code-body.ts (node.to-overshoot robustness lives there).
    const { openFenceLine, closeFenceLine, bodyStartLine, bodyEndLine } = fencedCodeFenceLandmarks(
      doc,
      sn
    );
    const hasBody = bodyStartLine !== null;
    const blockRevealed = fencedCodeBlockRevealed(doc, ctx.selection, sn);
    const landmarks: FencedLandmarks = {
      openFenceLine,
      closeFenceLine,
      firstBodyLine: bodyStartLine,
      lastBodyLine: bodyEndLine,
      // Block-scoped: both fences conceal together, only when the caret is OUTSIDE
      // the whole block (predicate shared with fenced-code-reveal.ts).
      openConcealed: hasBody && !blockRevealed,
      closeConcealed: closeFenceLine !== null && hasBody && !blockRevealed,
    };
    return {
      from: sn.from,
      to: sn.to,
      classesForLine: (n) => fencedCodeLineClasses(n, landmarks),
    };
  });
}

/** ViewPlugin for the blockquote rule. Rebuild triggers: the STRUCTURAL set
 *  (doc / viewport / parsed-tree / exclusion-zone change) PLUS `selectionSet` —
 *  but the caret-move trigger is GATED on a cached `hasConcealableBoundaryFence`
 *  flag, so a document with NO blockquote-boundary fence stays off the
 *  caret-move rebuild path (selection-INDEPENDENT in the common case; only a
 *  blockquote whose first/last line is a concealable fence re-walks on a caret
 *  move, to migrate its edge). Module-level const (stable identity) so
 *  `view.plugin(blockquoteRule)` resolves in tests. */
export const blockquoteRule = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** Cached, selection-INDEPENDENT: does any blockquote have a concealable
     *  fence at a boundary? Recomputed only on the structural (doc / viewport /
     *  tree / zones) rebuild; read O(1) on a selectionSet transaction to decide
     *  whether the caret move could change a migrated edge. Keeps the common
     *  (no boundary-fence) document off the caret-move rebuild path. */
    private hasBoundaryFence: boolean;
    constructor(view: EditorView) {
      const built = buildBlockquoteRuleWithBoundaryInfo(
        toCtx(view),
        view.state.facet(quollSyntaxExclusionZones)
      );
      this.decorations = built.decorations;
      this.hasBoundaryFence = built.hasConcealableBoundaryFence;
    }
    update(u: ViewUpdate): void {
      const structural =
        u.docChanged ||
        u.viewportChanged ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.startState.facet(quollSyntaxExclusionZones) !== u.state.facet(quollSyntaxExclusionZones);
      // Rebuild on any structural change, OR on a caret move ONLY when a
      // blockquote has a concealable boundary fence whose conceal state the move
      // could flip (edge migration). The flag gate keeps the common case
      // selection-INDEPENDENT (no caret-move re-walk).
      if (structural || (u.selectionSet && this.hasBoundaryFence)) {
        const built = buildBlockquoteRuleWithBoundaryInfo(
          toCtx(u.view),
          u.view.state.facet(quollSyntaxExclusionZones)
        );
        this.decorations = built.decorations;
        this.hasBoundaryFence = built.hasConcealableBoundaryFence;
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/** Selection-AWARE ViewPlugin for the fenced-code panel. Same triggers as
 *  blockquoteRule PLUS `selectionSet` (a concealed fence row collapses and the
 *  panel edge follows the first/last VISIBLE line, so the geometry depends on
 *  the caret). CodeMirror unions this plugin's Decoration.line classes with
 *  blockquoteRule's on a shared `> ```…` ` line, so a nested fence still gets
 *  both. Module-level const so `view.plugin(fencedCodePanel)` resolves in tests. */
export const fencedCodePanel = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildFencedCodePanel(
        toCtx(view),
        view.state.facet(quollSyntaxExclusionZones)
      );
    }
    update(u: ViewUpdate): void {
      if (
        u.docChanged ||
        u.viewportChanged ||
        u.selectionSet ||
        syntaxTree(u.startState) !== syntaxTree(u.state) ||
        u.startState.facet(quollSyntaxExclusionZones) !== u.state.facet(quollSyntaxExclusionZones)
      ) {
        this.decorations = buildFencedCodePanel(
          toCtx(u.view),
          u.view.state.facet(quollSyntaxExclusionZones)
        );
      }
    }
  },
  { decorations: (v) => v.decorations }
);

/** The block-style extension bundle: both line-decoration plugins as one
 *  Extension. editor.ts and the mount-based tests register THIS (not the two
 *  plugins individually) so the "both must be registered; CodeMirror unions
 *  their classes on a shared line" contract cannot be half-dropped. Tests that
 *  need a specific plugin instance (`view.plugin(...)`) import `blockquoteRule`
 *  / `fencedCodePanel` directly. `as const satisfies Extension` freezes the
 *  tuple (no accidental push/sort, and `view.plugin(blockStyle)` becomes a type
 *  error — Codex 92/93). Listed blockquote-first as the flatten order; this is
 *  NOT relied on for class precedence (tests assert class presence order-
 *  independently — CM's shared-line class order is not a public guarantee). */
export const blockStyle = [blockquoteRule, fencedCodePanel] as const satisfies Extension;
