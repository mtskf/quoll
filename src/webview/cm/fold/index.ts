// Quoll fold gutter: PURE UI activation of CM-core folding for Markdown.
//
// Heading folds come from Quoll's re-implementation of lang-markdown's headerIndent
// foldService (in cm/markdown.ts — re-implemented to avoid the markdown() wrapper's
// HTML stack); every other Block fold comes from lang-markdown's foldNodeProp on
// markdownLanguage.parser, MINUS a Blockquote/Paragraph/code-block/Table subtraction
// that also lives in cm/markdown.ts (`nonFoldableBlocks`), NOT here. (lang-markdown folds headings via its
// headerIndent foldService AND every non-Document, non-heading Block — ListItem,
// Paragraph, Blockquote, fenced/indented code, GFM tables — via foldNodeProp. We
// override foldNodeProp for Blockquote + Paragraph + code blocks + tables to null so
// prose blockquotes, standalone multi-line paragraphs, code blocks, and the
// display-only table block widget show no chevron, while headings/lists still fold.
// A foldService cannot subtract foldNodeProp — see cm/markdown.ts + docs/LEARNING.md.)
// This module only mounts the machinery:
//   - codeFolding({ placeholderDOM }) — foldState field + the INLINE placeholder
//                                 builder (foldPlaceholderDOM: the collapsed-region
//                                 pill, replacing CM's default grey box). foldGutter()
//                                 also bundles codeFolding() (harmless duplicate —
//                                 foldState is a singleton StateField), but the
//                                 placeholderDOM config must ride THIS explicit call.
//   - foldGutter({ markerDOM }) — the clickable chevron (a MOUSE affordance; the
//                                 gutter is aria-hidden by CM, so keyboard a11y
//                                 is foldKeymap below, not the marker's ARIA).
//   - keymap.of(quollFoldKeymap)  — the four fold commands (foldCode / unfoldCode /
//                                 foldAll / unfoldAll). Explicit Quoll-owned table —
//                                 see quollFoldKeymap below.
//   - gutterLineClass           — three fields tag gutter lines for theme use:
//                                 headingFoldGutterLineClass (H1–H3: caps the
//                                 chevron at the taller row height),
//                                 listFoldGutterLineClass (list-item marker lines:
//                                 insets chevron past the item's top-padding gap),
//                                 headingRhythmFoldGutterLineClass (H2–H3 rhythm-
//                                 padded lines: compensates the extra top padding);
//                                 see all three fields + the theme note.
//   - chevron theme             — glyph colour/size + the chevron's own placement
//                                 (horizontal nudge into the reading-column gap and
//                                 vertical centring on each foldable line's FIRST
//                                 text row). The reading-column GROUP centring
//                                 (gutter+content pair) is owned by cm/theme.ts.
//
// Auto-unfold on caret / edit is NATIVE: foldState clears a fold on a `delete`
// that touches it, or when the selection head lands inside it (real click /
// typing carries a selection) — verified in @codemirror/language 6.12.3. No
// custom listener — adding one would only duplicate native behaviour and risk
// dispatch-ordering issues with edit-sync. (Search is N/A — no @codemirror/search.)
//
// View-layer only: nothing here dispatches a `changes` transaction or posts an
// `edit` — folds are display-only, byte-identical round-trip.

import {
  codeFolding,
  foldAll,
  foldCode,
  foldGutter,
  syntaxTree,
  syntaxTreeAvailable,
  unfoldAll,
  unfoldCode,
} from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type RangeSet,
  StateField,
  type Transaction,
} from "@codemirror/state";
import {
  EditorView,
  GutterMarker,
  gutterLineClass,
  type KeyBinding,
  keymap,
} from "@codemirror/view";

// The list-fold gutter offset must stay in lock-step with the `.quoll-list-hang`
// content-line padding it compensates for, so it reuses the SAME eligibility
// predicates as list-hang-indent.ts: `isRenderableListItem` (the O(1) form of
// `resolveListItemHang === null` — empty / malformed / invalid-marker item — with
// no O(depth) geometry walk, since a whole-doc gutter walk only needs the
// null/non-null bit) and `pointInExclusionZone` (frontmatter, whose YAML lists
// parse as markdown ListItems but receive no hang). See collectListMarks.
import { type Interval, mergeIntervals } from "../bounded-recompute.js";
import { headingRhythmLevel } from "../decorations/heading-rhythm.js";
import { quollSyntaxExclusionZones } from "../decorations/orchestrator.js";
import { pointInExclusionZone } from "../decorations/shared.js";
import { isRenderableListItem, listItemGetsVerticalGap } from "../list/list-geometry.js";
import { buildSortedRangeSet } from "../sorted-range-set.js";
import { expandToEnclosingBlock, touchesStructuralReparse } from "../structural-guard.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide (https://lucide.dev, MIT) `chevron-down` glyph path. ONE icon for both
 *  fold states: expanded renders it as-is (points down); folded rotates the SAME
 *  SVG `-90deg` (points right) via the `--folded` class — no second path. Inlined
 *  via createElementNS per the project's supply-chain default-deny (we don't add
 *  the `lucide` package for one static icon; createElementNS avoids innerHTML, so
 *  no CSP/inline-style concern). Exported so the fold test can assert the path. */
export const CHEVRON_DOWN_PATH = "m6 9 6 6 6-6";

/** The chevron marker. The fold gutter is a MOUSE affordance: CodeMirror marks
 *  `.cm-gutters` aria-hidden, so a role/aria-label here would never reach
 *  assistive tech — `title` gives a hover tooltip for sighted mouse users
 *  instead, and the SVG is aria-hidden. Keyboard + screen-reader users fold via
 *  quollFoldKeymap (Ctrl-Shift-[ / ]), the real a11y path. CM wires the click→toggle
 *  handler on the gutter element itself, so markerDOM only supplies the glyph.
 *  Exported for the DOM-contract unit test. */
export function markerDOM(open: boolean): HTMLElement {
  const el = document.createElement("span");
  el.className = open ? "quoll-fold-marker" : "quoll-fold-marker quoll-fold-marker--folded";
  el.title = open ? "Fold" : "Unfold";

  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", CHEVRON_DOWN_PATH);
  svg.appendChild(path);
  el.appendChild(svg);
  return el;
}

/** Lucide (https://lucide.dev, MIT) `ellipsis` glyph: three horizontal dots at
 *  cx 5 / 12 / 19, cy 12, r 1 on a 24×24 grid. Lucide renders them as r=1 circles
 *  stroked at width 2 (the stroke fills the disc), so the dots inherit the SVG's
 *  `currentColor`. Inlined via createElementNS for the same supply-chain /
 *  CSP reasons as CHEVRON_DOWN_PATH (no `lucide` package for one static icon, no
 *  innerHTML). Exported so the fold-placeholder test can assert the dot geometry. */
export const ELLIPSIS_DOT_CX = [5, 12, 19] as const;

/** The INLINE fold placeholder — the marker CM shows IN PLACE of a collapsed
 *  region (distinct from the gutter chevron `markerDOM` above). Replaces CM's
 *  default bordered-grey `.cm-foldPlaceholder` "…" box with a filled rounded-square
 *  (16×12, r=4px) holding a knocked-out Lucide ellipsis (the dots are painted in
 *  the page background so they read as holes punched out of the fill; hover tints
 *  the square the shared fold-green).
 *  CM calls this as `placeholderDOM(view, onclick, prepared)`; we wire the supplied
 *  `onclick` for click-to-unfold and keep the default's `title` + `aria-label`
 *  (via `state.phrase`, mirroring widgetToDOM in @codemirror/language). We
 *  deliberately DON'T set the `cm-foldPlaceholder` class, so CM's default box theme
 *  never matches — our own `quoll-fold-placeholder` class carries the whole look
 *  (see quollFoldTheme). View-layer only: folds are display-only, byte-identical
 *  round-trip. Exported for the DOM-contract unit test. */
export function foldPlaceholderDOM(view: EditorView, onclick: (event: Event) => void): HTMLElement {
  const el = document.createElement("span");
  el.className = "quoll-fold-placeholder";
  el.title = view.state.phrase("unfold");
  el.setAttribute("aria-label", view.state.phrase("folded content"));
  el.onclick = onclick;

  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  for (const cx of ELLIPSIS_DOT_CX) {
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", "12");
    dot.setAttribute("r", "1");
    svg.appendChild(dot);
  }
  el.appendChild(svg);
  return el;
}

// Heading levels whose CONTENT font-size exceeds the body (theme.ts
// quollHighlightSpec: H1 1.8em / H2 1.5em / H3 1.2em). H4–H6 render at body size,
// so their gutter box is a normal row and they need no special cap.
type HeadingLevel = 1 | 2 | 3;
// ATX (`# …`) and Setext (`…\n===`) headings both carry the heading1/2/3 tags, so
// both inflate the line box. Setext only reaches level 2; the [1-3] class is
// harmless for it.
const HEADING_NODE = /^(?:ATXHeading|SetextHeading)([1-3])$/;

/** A gutter-line marker that ONLY adds a class (no `toDOM`). gutterLineClass
 *  applies it to the per-line gutter element across EVERY gutter — including the
 *  fold gutter's `.cm-gutterElement` — which is what lets `quollFoldTheme` give
 *  heading lines a taller first-row cap (see the alignment note on the theme). */
class HeadingFoldGutterMarker extends GutterMarker {
  override elementClass: string;
  constructor(readonly level: HeadingLevel) {
    super();
    this.elementClass = `quoll-fold-heading-${level}`;
  }
  override eq(other: HeadingFoldGutterMarker): boolean {
    return other.level === this.level;
  }
}
const HEADING_GUTTER_MARKER: Record<HeadingLevel, HeadingFoldGutterMarker> = {
  1: new HeadingFoldGutterMarker(1),
  2: new HeadingFoldGutterMarker(2),
  3: new HeadingFoldGutterMarker(3),
};

/** Collect every H1–H3 heading marker whose node OVERLAPS [rangeFrom, rangeTo].
 *  Called with [0, doc.length] for a full (re)build and with each bounded block
 *  interval on the keystroke path (defineFoldGutterLineClass's bounded recompute). A bounded
 *  `{from,to}` iterate materialises only the touched subtree, sidestepping the
 *  whole-tree-materialisation cost a full `iterate()` pays on every keystroke
 *  (PERF.md measured ~5 ms/MB — the cost is materialisation, not node descent, so
 *  this mirrors image-field.ts's changed-range `buildRange`, NOT a prune-descent
 *  shortcut). Doc order → the returned marks are already sorted by `from`. */
function collectHeadingMarks(
  state: EditorState,
  rangeFrom: number,
  rangeTo: number
): { from: number; marker: HeadingFoldGutterMarker }[] {
  const out: { from: number; marker: HeadingFoldGutterMarker }[] = [];
  let lastLineFrom = -1;
  syntaxTree(state).iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      const match = HEADING_NODE.exec(node.name);
      if (!match) {
        return;
      }
      // The marker rides a heading's FIRST line (the sole line for ATX, the title
      // line for a multi-line Setext).
      const lineFrom = state.doc.lineAt(node.from).from;
      // Guard against double-adding if the tree ever surfaces nested
      // heading-tagged nodes on the same line (RangeSet requires strictly
      // non-decreasing, de-duplicated positions).
      if (lineFrom === lastLineFrom) {
        return;
      }
      lastLineFrom = lineFrom;
      out.push({ from: lineFrom, marker: HEADING_GUTTER_MARKER[Number(match[1]) as HeadingLevel] });
    },
  });
  return out;
}

/** Content-equality of two exclusion-zone lists UNDER the transaction's change
 *  map: true iff same length AND each prior zone, MAPPED through tr.changes,
 *  coincides with the corresponding new zone. `quollSyntaxExclusionZones` combines
 *  via `sources.flat()` (no comparator) and its always-mounted contributors
 *  (calloutMarkerConcealField, the frontmatter field) emit a FRESH array on every
 *  docChanged — so the facet VALUE churns its reference every keystroke even when
 *  the zones are unchanged. A reference check (`start.facet !== state.facet`) would
 *  therefore be true on every keystroke and force the full-rebuild fallback
 *  unconditionally, defeating the bounding in production (verified 2026-07-06).
 *  Comparing CONTENT under the change map instead bounds on ordinary keystrokes
 *  (zones only shift with the edit → mapped-equal) and full-rebuilds only when a
 *  zone genuinely appears / disappears / resizes. Soundness: mapped-equal zones ⟹
 *  no item OUTSIDE the changed block flips its exclusion-zone membership (every zone
 *  occupies the same text span it did before, and out-of-block items did not move
 *  relative to it). On a non-docChanged transaction tr.changes is empty, so mapPos
 *  is identity and this is a plain content compare. Zone order is stable (fixed
 *  contributor order, each doc-ordered), so the positional compare is exact. */
function exclusionZonesUnchanged(
  tr: Transaction,
  prev: readonly { from: number; to: number }[],
  next: readonly { from: number; to: number }[]
): boolean {
  if (prev.length !== next.length) {
    return false;
  }
  for (let i = 0; i < prev.length; i++) {
    if (tr.changes.mapPos(prev[i].from) !== next[i].from) {
      return false;
    }
    if (tr.changes.mapPos(prev[i].to) !== next[i].to) {
      return false;
    }
  }
  return true;
}

/** One per-line gutter marker at document offset `from`. */
type FoldGutterMark = { from: number; marker: GutterMarker };

/** Spec for `defineFoldGutterLineClass` — a DISCRIMINATED UNION on `zoneAware` so the
 *  flag and `collect`'s arity move together: a zone-aware field MUST supply a 4-arg
 *  `collect(state, zones, from, to)` and a non-zone-aware field a 3-arg
 *  `collect(state, from, to)`. This makes the dangerous mis-pairing a COMPILE error
 *  rather than a latent bug ("判断に頼るな、仕組みで防げ"): wiring a zone-dependent walk
 *  (4-arg) as `zoneAware: false` — which would feed it empty zones AND skip the
 *  facet-flip rebuild, silently mis-tagging frontmatter YAML list items — no longer
 *  type-checks (a 4-arg function is not assignable to the 3-arg branch). The pairing is
 *  SYMMETRIC: the reverse (a 3-arg walk declared `zoneAware: true`) is rejected too —
 *  positional parameter matching lands the walk's 2nd param (`rangeFrom: number`) in the
 *  `zones` slot, and `number` is not assignable from `readonly {from,to}[]`. So each
 *  `zoneAware` value admits exactly its own `collect` arity, and neither cross-pairing
 *  compiles. */
type FoldGutterFieldSpec =
  | {
      zoneAware: true;
      collect: (
        state: EditorState,
        zones: readonly { from: number; to: number }[],
        rangeFrom: number,
        rangeTo: number
      ) => FoldGutterMark[];
    }
  | {
      zoneAware: false;
      collect: (state: EditorState, rangeFrom: number, rangeTo: number) => FoldGutterMark[];
    };

/** The three gutter line-class fields (`headingFoldGutterLineClass`,
 *  `listFoldGutterLineClass`, `headingRhythmFoldGutterLineClass`) share one shape:
 *  a `RangeSet<GutterMarker>` built by a full walk, bounded-recomputed on the
 *  keystroke path, and rebuilt on structural reparse / incomplete parse frontier /
 *  async background parse. They differ ONLY in (a) the per-field eligibility walk
 *  (`collect`) and (b) whether they read the `quollSyntaxExclusionZones` facet
 *  (`zoneAware`): the H1–H3 row-scale field is NOT zone-aware (its eligibility never
 *  depends on frontmatter/callout zones), while the list + rhythm fields are (a zone
 *  boundary shift can re-include / exclude items far from the edit). This factory owns
 *  the shared machinery so those two axes are the only per-field code.
 *
 *  `zoneAware` gates `facetChanged`: a non-zone-aware field computes it as a constant
 *  `false` (the `spec.zoneAware &&` short-circuit means the facet is NEVER read), so it
 *  never takes a facet-flip rebuild branch — reproducing the H1–H3 field's exact
 *  pre-factory behaviour (it had no facet term at all). This keeps the bounded≡full
 *  invariant intact per field (memory
 *  `[[quoll-fold-bounded-equals-full-tests-flaky-under-load]]`). The `spec.zoneAware &&`
 *  MUST stay first so a non-zone-aware field skips the facet read entirely. The flag ↔
 *  `collect`-arity pairing itself is compile-enforced by `FoldGutterFieldSpec` (see there).
 *
 *  Distinct concern from the deliberately-un-factored `defineBlockWidgetField`
 *  (LEARNING.md 2026-06-29): block widgets carry an ORDINAL contract that makes their
 *  two bound mechanisms heterogeneous. Gutter line-class fields have no ordinal — they
 *  are pure buildSortedRangeSet + map/update triples, so rule-of-three is satisfied. */
function defineFoldGutterLineClass(spec: FoldGutterFieldSpec): StateField<RangeSet<GutterMarker>> {
  // Run the per-field eligibility walk over [rangeFrom, rangeTo], threading the
  // exclusion zones a zone-aware field needs and calling the matching arity (the
  // union narrows `spec.collect` on `spec.zoneAware`). A non-zone-aware field never
  // reads the facet at all — the `spec.zoneAware ?` discriminant short-circuits the
  // whole `state.facet(...)` read, reproducing its exact pre-factory behaviour.
  const collectMarks = (
    state: EditorState,
    rangeFrom: number,
    rangeTo: number
  ): FoldGutterMark[] =>
    spec.zoneAware
      ? spec.collect(state, state.facet(quollSyntaxExclusionZones), rangeFrom, rangeTo)
      : spec.collect(state, rangeFrom, rangeTo);

  const build = (state: EditorState): RangeSet<GutterMarker> =>
    buildSortedRangeSet(collectMarks(state, 0, state.doc.length), (m) => [
      m.from,
      m.from,
      m.marker,
    ]);

  // Changed-range bounded recompute for the keystroke path: map the prior marker
  // set through the change, then re-walk ONLY the enclosing block of each changed
  // range and splice the fresh marks back in. `filter: () => false` drops exactly the
  // stale marks each `collect` re-emits inside the interval; markers outside every
  // interval are position-mapped and retained untouched. Per-collect soundness (the
  // list straddle clamp, the heading up-walk that guarantees a marker line lands in
  // its own interval) is argued at each `collect*` function.
  const recompute = (prev: RangeSet<GutterMarker>, tr: Transaction): RangeSet<GutterMarker> => {
    const state = tr.state;
    const raw: Interval[] = [];
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
      raw.push(expandToEnclosingBlock(state, fromB, toB));
    });
    let result = prev.map(tr.changes);
    for (const iv of mergeIntervals(raw)) {
      const add = collectMarks(state, iv.from, iv.to).map((m) => m.marker.range(m.from));
      result = result.update({ filterFrom: iv.from, filterTo: iv.to, filter: () => false, add });
    }
    return result;
  };

  return StateField.define<RangeSet<GutterMarker>>({
    create: build,
    update(value, tr) {
      const facetChanged =
        spec.zoneAware &&
        !exclusionZonesUnchanged(
          tr,
          tr.startState.facet(quollSyntaxExclusionZones),
          tr.state.facet(quollSyntaxExclusionZones)
        );
      if (tr.docChanged) {
        // A facet flip can change eligibility OUTSIDE the changed range (zone-aware
        // fields only); a STRUCTURAL reparse re-shapes block boundaries beyond the
        // changed run; and an incomplete post-edit parse frontier can reveal nodes
        // outside it — all three need a full rebuild. Otherwise bound the walk to the
        // changed blocks. (`facetChanged` is a constant `false` for a non-zone-aware
        // field, so it never forces a rebuild there.)
        if (
          facetChanged ||
          touchesStructuralReparse(tr) ||
          !syntaxTreeAvailable(tr.state, tr.state.doc.length)
        ) {
          return build(tr.state);
        }
        return recompute(value, tr);
      }
      // Non-docChanged: lang-markdown's async background parse arrives as a tree-identity
      // change, and (zone-aware only) a zone contributor can flip on a selection-only
      // transaction — either re-tags via a full rebuild. Otherwise the set is unchanged.
      if (syntaxTree(tr.startState) !== syntaxTree(tr.state) || facetChanged) {
        return build(tr.state);
      }
      return value;
    },
    provide: (field) => gutterLineClass.from(field),
  });
}

/** Tags H1–H3 lines with `quoll-fold-heading-{level}` on their gutter element via
 *  the `gutterLineClass` facet. Built by `defineFoldGutterLineClass` (NOT zone-aware —
 *  heading row-scale eligibility never depends on exclusion zones). On the keystroke
 *  path (docChanged, parse frontier reached) it recomputes ONLY the changed blocks
 *  instead of re-walking the whole syntax tree, mirroring image-field.ts. Two
 *  full-rebuild fallbacks preserve correctness: (a) a docChanged whose post-edit
 *  frontier is incomplete (`!syntaxTreeAvailable`) can reveal nodes outside the
 *  changed range, and (b) lang-markdown parses asynchronously, so a later
 *  background-parse publication arrives as a NON-docChanged transaction whose tree
 *  identity differs — re-tagging once the real heading nodes land. A third full-rebuild
 *  fallback (touchesStructuralReparse) catches a STRUCTURAL reparse that re-shapes a
 *  block boundary OUTSIDE the changed run — an unclosed fence / `<script>` swallowing a
 *  far heading, a `<!DOCTYPE …>` terminator, a `#`-ATX interrupt (see the guard's doc):
 *  the bounded window would strand such a heading's marker. Eligibility walk:
 *  collectHeadingMarks. Exported for the heading-detection contract test. */
export const headingFoldGutterLineClass = defineFoldGutterLineClass({
  zoneAware: false,
  collect: collectHeadingMarks,
});

/** A gutter-line marker tagging a list-item MARKER line's fold-gutter element so
 *  the theme can inset its chevron by the same `--quoll-list-item-gap` that
 *  list-hang-indent.ts adds as `padding-top` to the `.cm-line` (PR #13's
 *  inter-item breathing room). All list markers are interchangeable (unlike the
 *  per-level heading markers), so `eq` is unconditionally true. */
class ListFoldGutterMarker extends GutterMarker {
  override elementClass = "quoll-fold-list-marker";
  override eq(): boolean {
    return true;
  }
}
const LIST_FOLD_GUTTER_MARKER = new ListFoldGutterMarker();

/** Collect every eligible list-item MARKER whose node OVERLAPS [rangeFrom, rangeTo]
 *  — same eligibility gate as the full build (exclusion zone + isRenderableListItem
 *  + listItemGetsVerticalGap — tight siblings get no gap and no gutter offset).
 *  Called with [0, doc.length] for a full (re)build and with each bounded block
 *  interval on the keystroke path (defineFoldGutterLineClass's bounded recompute). A bounded {from,to}
 *  iterate materialises only the touched subtree, sidestepping the whole-tree
 *  materialisation cost a full iterate pays on every keystroke (PERF.md: the cost is
 *  materialisation, not node descent).
 *
 *  CLAMP (the sole shape difference vs collectHeadingMarks): drop any mark whose
 *  line starts BEFORE rangeFrom. A LOOSE list item spans its interior blank line as
 *  ONE ListItem (verified: `- a\n\n  cont` → ListItem[0,11], ListMark on line 1,
 *  continuation on line 3, verified against @lezer/markdown). A keystroke confined to
 *  the continuation expands only to [contLine, …] (expandToEnclosingBlock stops at
 *  the interior blank line), yet iterate({from}) still ENTERS the straddling ListItem
 *  via Lezer TOUCH and would emit a mark at its far-above ListMark line — OUTSIDE the
 *  recompute window, which the bounded recompute would then double-add on top of
 *  the retained (position-mapped) prior mark. The clamp is SOUND: such an edit cannot
 *  flip that item's eligibility (isRenderableListItem reads only its OWN ListMark +
 *  first content node, never a later continuation), so its prior mark is already
 *  correct and stays untouched. `listItemGetsVerticalGap` extends this same
 *  bounded-soundness argument: it reads only lines AT OR ABOVE the marker (the
 *  immediately-previous line and, via the tree, the outermost list's start line),
 *  never a later continuation, so it is unaffected by an in-window continuation
 *  edit for the same reason. Any edit that COULD flip a far item's verdict either
 *  trips `touchesStructuralReparse` (a full rebuild — including the TABLE-DELIM
 *  arm for a GFM table delimiter row completing/breaking outside this window) or
 *  falls inside the marker's own `expandToEnclosingBlock` run. Headings never
 *  straddle a blank line (ATX is one line;
 *  Setext is a contiguous title+underline run), so collectHeadingMarks needs no clamp.
 *  In the full build (rangeFrom = 0) the clamp never fires. Doc order → sorted by
 *  from. */
function collectListMarks(
  state: EditorState,
  zones: readonly { from: number; to: number }[],
  rangeFrom: number,
  rangeTo: number
): { from: number; marker: GutterMarker }[] {
  const out: { from: number; marker: GutterMarker }[] = [];
  let lastLineFrom = -1;
  syntaxTree(state).iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      if (node.name !== "ListItem") {
        return;
      }
      const lineFrom = state.doc.lineAt(node.from).from;
      // Straddle clamp — see the doc comment. A loose ListItem entered via TOUCH
      // may start above the window; its marker is outside [rangeFrom,…] and its
      // eligibility is unaffected by an in-window continuation edit.
      if (lineFrom < rangeFrom) {
        return;
      }
      // Emit ONLY for lines that actually receive `.quoll-list-hang` padding, so the
      // gutter offset stays in lock-step with the content-line gap it compensates
      // for (see the field doc): (1) an exclusion zone — a frontmatter YAML list
      // parses as markdown ListItems but gets no hang; (2) a non-renderable item —
      // malformed (no ListMark / no content), or an invalid-marker Task on a
      // one-update-behind tree (an EMPTY item is now renderable and IS tagged, in
      // lock-step with its new hang)
      // (isRenderableListItem is the O(1) mirror of resolveListItemHang === null).
      if (pointInExclusionZone(lineFrom, zones)) {
        return;
      }
      if (!isRenderableListItem(state, node.node)) {
        return;
      }
      // Lock-step with the content line's `.quoll-list-hang` padding: emit a
      // gutter offset ONLY for items that actually receive the vertical gap
      // (see list-hang-indent.ts). Tight consecutive siblings get neither.
      if (!listItemGetsVerticalGap(state, node.node)) {
        return;
      }
      // ListItems are visited in document order, but a nested item shares its
      // parent's marker line only for pathological same-line nesting (`- - a`);
      // guard against double-adding (RangeSetBuilder requires strictly
      // non-decreasing, de-duplicated positions), mirroring the heading builder.
      if (lineFrom === lastLineFrom) {
        return;
      }
      lastLineFrom = lineFrom;
      out.push({ from: lineFrom, marker: LIST_FOLD_GUTTER_MARKER });
    },
  });
  return out;
}

/** Tags every list-item MARKER line with `quoll-fold-list-marker` on its gutter
 *  element via `gutterLineClass`, in lock-step with the `.cm-line.quoll-list-hang`
 *  padding it compensates for (same three-predicate eligibility gate — exclusion zone
 *  + isRenderableListItem + listItemGetsVerticalGap [tight siblings get no gap and no
 *  gutter offset]; see collectListMarks). Built by `defineFoldGutterLineClass`
 *  (zone-aware). On the keystroke path (docChanged, parse frontier reached, no facet
 *  flip) it recomputes ONLY the changed blocks instead of re-walking the whole syntax
 *  tree, mirroring headingFoldGutterLineClass. Two full-rebuild fallbacks preserve
 *  correctness: (a) a docChanged whose post-edit frontier is incomplete
 *  (`!syntaxTreeAvailable`) can reveal nodes outside the changed range, and (b)
 *  lang-markdown parses asynchronously, so a later background-parse publication
 *  arrives as a NON-docChanged transaction whose tree identity differs — re-tagging
 *  once the real list nodes land. A third fallback: a docChanged that ALSO flips the
 *  `quollSyntaxExclusionZones` facet takes the full-rebuild path because a zone
 *  boundary shift can re-include / exclude list items outside the changed range. The
 *  non-docChanged facet-flip path (zone contributor that fires on a selection-only
 *  transaction) still full-rebuilds for the same reason. The facet guard compares zone
 *  CONTENT under the change map (exclusionZonesUnchanged), not reference — always-
 *  mounted contributors (calloutMarkerConcealField, frontmatter) emit a fresh array on
 *  every docChanged, so a reference check would defeat bounding on every keystroke.
 *  Lock-step / two-predicate paragraphs: see the collectListMarks eligibility gate.
 *  Exported for the marker-detection contract test. */
export const listFoldGutterLineClass = defineFoldGutterLineClass({
  collect: collectListMarks,
  zoneAware: true,
});

// Heading levels 1-6, all rhythm-eligible (unlike the H1-3-only row-scale cap
// above — the rhythm padding applies at every level).
type HeadingRhythmLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** A gutter-line marker tagging a heading MARKER line's fold-gutter element so
 *  the theme can inset its chevron by the same `--quoll-heading-space-{bucket}`
 *  that heading-rhythm.ts adds as `padding-top` to the `.cm-line`. Per-level
 *  (like HeadingFoldGutterMarker) so the theme can look up the matching token;
 *  `eq` compares level so a level change re-tags. Distinct from the H1-3
 *  row-scale marker: this compensates the vertical RHYTHM padding, and applies to
 *  all six levels (a plain H4 gets rhythm padding but no row-scale cap). */
class HeadingRhythmFoldGutterMarker extends GutterMarker {
  override elementClass: string;
  constructor(readonly level: HeadingRhythmLevel) {
    super();
    this.elementClass = `quoll-fold-heading-rhythm-${level}`;
  }
  override eq(other: HeadingRhythmFoldGutterMarker): boolean {
    return other.level === this.level;
  }
}
const HEADING_RHYTHM_GUTTER_MARKER: Record<HeadingRhythmLevel, HeadingRhythmFoldGutterMarker> = {
  1: new HeadingRhythmFoldGutterMarker(1),
  2: new HeadingRhythmFoldGutterMarker(2),
  3: new HeadingRhythmFoldGutterMarker(3),
  4: new HeadingRhythmFoldGutterMarker(4),
  5: new HeadingRhythmFoldGutterMarker(5),
  6: new HeadingRhythmFoldGutterMarker(6),
};

/** Collect every rhythm-eligible heading MARKER whose node OVERLAPS [rangeFrom,
 *  rangeTo] — same eligibility gate as the full build (headingRhythmLevel: level
 *  match + top-level + not physical line 1 + not in an exclusion zone). Called with
 *  [0, doc.length] for a full (re)build and with each bounded block interval on the
 *  keystroke path. A bounded {from,to} iterate materialises only the touched subtree,
 *  sidestepping the whole-tree materialisation cost a full iterate pays on every
 *  keystroke (PERF.md: that cost is materialisation, not node descent). No straddle clamp
 *  (unlike collectListMarks): a heading never spans a blank line — ATX is one line,
 *  Setext is a contiguous title+underline run — so expandToEnclosingBlock's up-walk
 *  always puts the marker line at/after rangeFrom. Doc order → sorted by from. */
function collectHeadingRhythmMarks(
  state: EditorState,
  zones: readonly { from: number; to: number }[],
  rangeFrom: number,
  rangeTo: number
): { from: number; marker: GutterMarker }[] {
  const out: { from: number; marker: GutterMarker }[] = [];
  const tree = syntaxTree(state);
  let lastLineFrom = -1;
  tree.iterate({
    from: rangeFrom,
    to: rangeTo,
    enter: (node) => {
      const level = headingRhythmLevel(state, tree, node, zones);
      if (level === null) {
        return;
      }
      const lineFrom = state.doc.lineAt(node.from).from;
      // A heading rides one line; guard against double-adding if the tree ever
      // surfaces nested heading-tagged nodes on the same line (RangeSetBuilder
      // requires strictly non-decreasing, de-duplicated positions).
      if (lineFrom === lastLineFrom) {
        return;
      }
      lastLineFrom = lineFrom;
      out.push({
        from: lineFrom,
        marker: HEADING_RHYTHM_GUTTER_MARKER[level as HeadingRhythmLevel],
      });
    },
  });
  return out;
}

/** Tags every rhythm-eligible heading MARKER line with
 *  `quoll-fold-heading-rhythm-{level}` on its gutter element via `gutterLineClass`,
 *  in lock-step with the `.cm-line.quoll-heading-rhythm-{level}` padding it
 *  compensates for (SAME eligibility gate — headingRhythmLevel; see
 *  collectHeadingRhythmMarks). Built by `defineFoldGutterLineClass` (zone-aware). On
 *  the keystroke path (docChanged, parse frontier reached, no facet flip) it recomputes
 *  ONLY the changed blocks instead of re-walking the whole syntax tree, mirroring
 *  headingFoldGutterLineClass and listFoldGutterLineClass. Two full-rebuild fallbacks
 *  preserve correctness: (a) a docChanged whose post-edit frontier is incomplete
 *  (`!syntaxTreeAvailable`) can reveal nodes outside the changed range, and (b)
 *  lang-markdown parses asynchronously, so a later background-parse publication arrives
 *  as a NON-docChanged transaction whose tree identity differs — re-tagging once the
 *  real heading nodes land. A third fallback: a docChanged that ALSO flips the
 *  `quollSyntaxExclusionZones` facet takes the full-rebuild path because a zone boundary
 *  shift can re-include / exclude headings outside the changed range. The non-docChanged
 *  facet-flip path still full-rebuilds for the same reason. The facet guard compares
 *  zone CONTENT under the change map (exclusionZonesUnchanged), not reference — always-
 *  mounted contributors (calloutMarkerConcealField, frontmatter) emit a fresh array on
 *  every docChanged, so a reference check would defeat bounding on every keystroke. The
 *  emitted set is selection- AND viewport-independent. Exported for the heading-detection
 *  contract test. */
export const headingRhythmFoldGutterLineClass = defineFoldGutterLineClass({
  collect: collectHeadingRhythmMarks,
  zoneAware: true,
});

/** Chevron styling + placement. The reading-column GROUP centring lives in
 *  cm/theme.ts; here we (a) horizontally slide the chevron toward the text (see
 *  `.cm-foldGutter` `left` below — unchanged from #198) and (b) vertically centre
 *  the chevron on its foldable line's FIRST text row.
 *
 *  Alignment (#215 regression fix — design VERIFIED in the real-browser harness;
 *  happy-dom has no layout so this cannot be asserted in a unit test):
 *  CM sizes every `.cm-gutterElement` to its matched content line's pixel height
 *  (inline — @codemirror/view GutterElement.update), and the gutter renders at the
 *  BODY font-size, never the content line's. Two kinds of line inflate that box,
 *  and they want OPPOSITE anchoring:
 *    - a single TALL row — an H1/H2/H3 whose larger font makes one row taller than
 *      body — wants the chevron CENTRED on that row;
 *    - a MULTI-row box — a wrapped list item / paragraph (body font, `lineWrapping`
 *      on), a `block-style` fenced panel, a collapsed region — wants the chevron on
 *      the FIRST row, not the box middle (the #215 box-centring bug dropped it
 *      several rows down).
 *  No single CSS rule does both, because the gutter cannot tell "one tall heading
 *  row" from "stacked body rows". So we cap the marker at ONE row of THIS line's
 *  own font: `height: min(100%, oneRow)` with `align-items: center`. `min(100%, …)`
 *  means a single-row line (height == oneRow) box-centres, while a taller multi-row
 *  box keeps the capped marker block-flowed at the TOP → first-row anchor. `oneRow`
 *  is `--quoll-fold-row-scale × --quoll-line-height` em: the scale is 1 by default
 *  (body) and is bumped per heading level by `headingFoldGutterLineClass` below, so
 *  base lines cap at one body row (wrapped list items anchor to row 1) and headings
 *  cap at their own taller row (single-row headings centre, wrapped headings anchor
 *  to row 1). The scales MIRROR quollHighlightSpec's heading font-sizes in
 *  cm/theme.ts — keep the two in sync.
 *  (The old glyph `padding: 0 0.0625em` stays DROPPED: horizontal placement is the
 *  `.cm-foldGutter { left }` nudge + the SVG width, and `justify-content: center`
 *  owns in-box centring.) */
const quollFoldTheme = EditorView.theme({
  ".cm-foldGutter": {
    position: "relative",
    // Slid right toward the reading column (#198 baseline was 1.875rem) so the
    // chevron sits close to the content column without overlapping its glyphs.
    left: "2rem",
  },
  ".cm-foldGutter .quoll-fold-marker": {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "min(100%, calc(var(--quoll-fold-row-scale, 1) * var(--quoll-line-height, 1.7) * 1em))",
    cursor: "pointer",
    color: "var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground))",
    opacity: "0.6",
  },
  // Per-heading-level row cap (set on the heading line's gutter element by
  // headingFoldGutterLineClass). The marker inherits the var (custom props
  // inherit) and caps at one heading row instead of one body row. Mirrors
  // quollHighlightSpec H1 1.8em / H2 1.5em / H3 1.2em (cm/theme.ts).
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-1": { "--quoll-fold-row-scale": "1.8" },
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-2": { "--quoll-fold-row-scale": "1.5" },
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-3": { "--quoll-fold-row-scale": "1.2" },
  // List-item marker lines carry a `padding-top` of `--quoll-list-item-gap` INSIDE
  // their `.cm-line` box (list-hang-indent.ts's `.quoll-list-hang` + cm/theme.ts,
  // PR #13's inter-item breathing room). CM sizes the matching `.cm-gutterElement`
  // to that FULL padded height (border-box, inline px), so the top-anchored marker
  // would otherwise float that gap ABOVE the item's first text row. Mirror the SAME
  // top inset on the gutter element (set by listFoldGutterLineClass): border-box
  // keeps the element's total height unchanged (no cumulative drift), the marker's
  // `min(100%, oneRow)` now resolves 100% against the padding-reduced content box,
  // and it re-centres on the first text row. Referencing the SAME token keeps the
  // offset in lock-step if the gap is ever retuned. A plain heading (not in a
  // list) inflates via font-size (not padding) and is handled by the row-scale
  // cap above, so it is untagged here and stays centred. A heading nested in a
  // list item (`- # H`) DOES receive both classes, and they compound correctly:
  // that content line is a list item, so it carries `.quoll-list-hang` padding
  // (matched by this padding-top) AND renders at heading size (matched by the
  // row-scale cap) — the chevron centres on the padded heading row.
  ".cm-foldGutter .cm-gutterElement.quoll-fold-list-marker": {
    paddingTop: "var(--quoll-list-item-gap, 0.6em)",
  },
  // Heading lines carry a `padding-top` of `--quoll-heading-space-{bucket}` INSIDE
  // their `.cm-line` box (heading-rhythm.ts's `.quoll-heading-rhythm-{level}` +
  // cm/theme.ts). CM sizes the matching `.cm-gutterElement` to that FULL padded
  // height (border-box, inline px), so the top-anchored marker would otherwise
  // float that gap ABOVE the heading's text row — the same compounding the
  // list-marker rule above fixes. Mirror the SAME top inset on the gutter element
  // (set by headingRhythmFoldGutterLineClass): border-box keeps the element's
  // total height unchanged (no cumulative drift), the marker's `min(100%, oneRow)`
  // now resolves 100% against the padding-reduced content box, and it re-centres
  // on the heading's text row. Referencing the SAME tokens keeps the offset in
  // lock-step if a gap is ever retuned. For H1-3 this COMPOSES with the row-scale
  // cap above (a rhythm heading is both taller — larger font — AND padded, and the
  // two classes co-occur on the same gutter element): the row-scale cap centres
  // the chevron on the taller row while this padding-top pushes the whole capped
  // marker down past the rhythm gap. Levels 4/5/6 share --quoll-heading-space-4
  // (they render at body size, so no row-scale cap — this padding alone).
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-rhythm-1": {
    paddingTop: "var(--quoll-heading-space-1, 1.2em)",
  },
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-rhythm-2": {
    paddingTop: "var(--quoll-heading-space-2, 1em)",
  },
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-rhythm-3": {
    paddingTop: "var(--quoll-heading-space-3, 0.75em)",
  },
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-rhythm-4, .cm-foldGutter .cm-gutterElement.quoll-fold-heading-rhythm-5, .cm-foldGutter .cm-gutterElement.quoll-fold-heading-rhythm-6":
    {
      paddingTop: "var(--quoll-heading-space-4, 0.5em)",
    },
  // Folded = the same chevron-down rotated to point right, PLUS a theme-following
  // green tint so a collapsed region reads at a glance. Static (no transition): CM
  // rebuilds the marker DOM on every fold flip (FoldMarker.eq compares `open`), so
  // a freshly-mounted element renders directly at its final angle. Opacity is
  // pulled to full (base is 0.6) so the green is not washed out; the green token
  // follows the active VS Code theme (git-added foreground, charts-green fallback)
  // so it reads in both dark and light.
  ".cm-foldGutter .quoll-fold-marker--folded": {
    transform: "rotate(-90deg)",
    color: "var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green))",
    opacity: "1",
  },
  // Size the SVG into the line-number rhythm (replaces the old glyph font-size).
  // 1em enlarges the former 0.9em glyph; still well under the one-body-row cap
  // (~1.7em) and each taller heading row's cap, so single-row lines stay centred.
  ".cm-foldGutter .quoll-fold-marker svg": {
    display: "block",
    width: "1em",
    height: "1em",
  },
  ".cm-foldGutter .quoll-fold-marker:hover": {
    opacity: "1",
    color: "var(--vscode-editorLineNumber-activeForeground, var(--vscode-editor-foreground))",
  },
  // A folded chevron stays green on hover — this rule is emitted AFTER the neutral
  // :hover above so, at equal specificity, source order keeps the green (only the
  // expanded chevron brightens to the neutral active colour on hover).
  ".cm-foldGutter .quoll-fold-marker--folded:hover": {
    color: "var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green))",
  },
  // Inline fold placeholder (the collapsed-region marker; NOT the gutter chevron).
  // A filled rounded-square (16×12, r=4px, NO border) holding a knocked-out Lucide
  // ellipsis — the dots are painted in the PAGE background (currentColor below) so
  // they read as holes punched out of the fill. Colours are theme-following so the
  // marker tracks dark / light / HC automatically (memory
  // quoll-hc-theme-maps-to-light-theme-class):
  //   - fill = --quoll-fold-fill (styles.css per-theme token): a subtle neutral
  //     overlay in dark (rgba(255,255,255,.15)) / light (rgba(0,0,0,.15)) and a
  //     SOLID foreground square in HC, so the borderless marker stays visible in
  //     every theme (the fallback keeps a fill on a pre-theme-class frame);
  //   - dots = --vscode-editor-background (the page fill) via currentColor;
  //   - :hover tints the fill the shared fold-green (the SAME git-added / charts-
  //     green token the folded chevron uses) so the marker reads as an unfold
  //     affordance; the transition eases that colour flip (the element persists,
  //     unlike the chevron which CM rebuilds per fold).
  // A ~6px inline-start margin lifts the marker off the fold's first-line text.
  ".quoll-fold-placeholder": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: "16px",
    height: "12px",
    borderRadius: "4px",
    border: "none",
    marginInlineStart: "6px",
    verticalAlign: "middle",
    cursor: "pointer",
    transition: "background-color 100ms ease",
    backgroundColor: "var(--quoll-fold-fill, rgba(255, 255, 255, 0.15))",
    color: "var(--vscode-editor-background)",
  },
  ".quoll-fold-placeholder:hover": {
    backgroundColor:
      "var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green))",
  },
  ".quoll-fold-placeholder svg": {
    display: "block",
    width: "14px",
    height: "14px",
  },
});

/** Quoll's fold key bindings — an EXPLICIT, Quoll-owned copy of
 *  @codemirror/language's default `foldKeymap` (same keys, same commands). The point
 *  is to OWN a STABLE shortcut contract, not to track upstream: a copy deliberately
 *  does NOT follow a future CM change to its defaults, so Quoll's users keep these
 *  four shortcuts regardless, and any accidental in-repo removal turns a unit test
 *  red. (If the goal were the opposite — detect upstream drift — the right shape
 *  would be `= foldKeymap` + a `toEqual` drift guard; it is not.) Bindings (mirror
 *  the module header):
 *    - Ctrl-Shift-[ (Cmd-Alt-[ on macOS) -> foldCode   (fold the section at the caret)
 *    - Ctrl-Shift-] (Cmd-Alt-] on macOS) -> unfoldCode (unfold it)
 *    - Ctrl-Alt-[                         -> foldAll    (fold every section)
 *    - Ctrl-Alt-]                         -> unfoldAll  (unfold every section)
 *  All four are single-stroke combos that reach the focused webview iframe; we keep
 *  CM's proven bindings rather than VS Code's Ctrl-K-led fold-all chord, which the
 *  workbench swallows before the webview sees it (Command-Palette / package.json
 *  discoverability is a separate host-side follow-up). Display-only: each command
 *  mutates only foldState, never the document — byte-identical round-trip. Exported
 *  for the keymap-wiring unit tests. */
export const quollFoldKeymap: readonly KeyBinding[] = [
  { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[", run: foldCode },
  { key: "Ctrl-Shift-]", mac: "Cmd-Alt-]", run: unfoldCode },
  { key: "Ctrl-Alt-[", run: foldAll },
  { key: "Ctrl-Alt-]", run: unfoldAll },
];

/** The mounted keymap extension. `quollFolding()` includes THIS exact value so a
 *  test can assert by reference that the keymap is actually wired (not merely that
 *  the table exists). */
export const quollFoldKeymapExtension: Extension = keymap.of(quollFoldKeymap);

/** The Quoll fold extension. Always on (no setting) — chevrons appear only on
 *  foldable lines. `headingFoldGutterLineClass` tags H1–H3 gutter lines so the
 *  theme can cap their chevron at the correct (taller) row height;
 *  `listFoldGutterLineClass` tags list-item marker lines so the theme can inset
 *  their chevron past the item's `--quoll-list-item-gap` top padding (PR #13);
 *  `headingRhythmFoldGutterLineClass` likewise insets a heading's chevron past
 *  the `--quoll-heading-space-*` rhythm padding heading-rhythm.ts adds. */
export function quollFolding(): Extension {
  return [
    codeFolding({ placeholderDOM: foldPlaceholderDOM }),
    headingFoldGutterLineClass,
    listFoldGutterLineClass,
    // Insets a rhythm heading's chevron past the `--quoll-heading-space-*`
    // top padding heading-rhythm.ts adds to the `.cm-line`, so the chevron stays
    // centred on the heading row instead of floating down by the gap. Same
    // lock-step contract as listFoldGutterLineClass (PR #13).
    headingRhythmFoldGutterLineClass,
    foldGutter({ markerDOM }),
    quollFoldKeymapExtension,
    quollFoldTheme,
  ];
}
