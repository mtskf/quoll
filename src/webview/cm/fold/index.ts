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
//   - gutterLineClass           — tags H1–H3 gutter lines (headingFoldGutterLineClass)
//                                 so the theme can cap the chevron at the right
//                                 (taller) row height, AND tags list-item marker
//                                 lines (listFoldGutterLineClass) so the theme can
//                                 inset their chevron past the item's top-padding
//                                 gap; see both fields + the theme note.
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
  unfoldAll,
  unfoldCode,
} from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type RangeSet,
  RangeSetBuilder,
  StateField,
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
// predicates as list-hang-indent.ts: `resolveListItemHang === null` (empty /
// malformed / invalid-marker item) and `pointInExclusionZone` (frontmatter, whose
// YAML lists parse as markdown ListItems but receive no hang). See
// buildListFoldGutterClasses.
import { resolveListItemHang } from "../decorations/list-geometry.js";
import { quollSyntaxExclusionZones } from "../decorations/orchestrator.js";
import { pointInExclusionZone } from "../decorations/shared.js";

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

function buildHeadingFoldGutterClasses(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  let lastLineFrom = -1;
  syntaxTree(state).iterate({
    enter: (node) => {
      const match = HEADING_NODE.exec(node.name);
      if (!match) {
        return;
      }
      const lineFrom = state.doc.lineAt(node.from).from;
      // A heading is a single line; guard against double-adding if the tree ever
      // surfaces nested heading-tagged nodes on the same line (RangeSetBuilder
      // requires strictly non-decreasing, de-duplicated positions).
      if (lineFrom === lastLineFrom) {
        return;
      }
      lastLineFrom = lineFrom;
      builder.add(lineFrom, lineFrom, HEADING_GUTTER_MARKER[Number(match[1]) as HeadingLevel]);
    },
  });
  return builder.finish();
}

/** Tags H1–H3 lines with `quoll-fold-heading-{level}` on their gutter element via
 *  the `gutterLineClass` facet. Recomputed when the doc OR the parse tree changes
 *  — lang-markdown parses asynchronously, so the tree the field sees at `create`
 *  is often incomplete; keying `update` on the tree identity (not just
 *  `docChanged`) re-tags once the real heading nodes land. Exported for the
 *  heading-detection contract test. */
export const headingFoldGutterLineClass = StateField.define<RangeSet<GutterMarker>>({
  create: buildHeadingFoldGutterClasses,
  update(value, tr) {
    if (!tr.docChanged && syntaxTree(tr.startState) === syntaxTree(tr.state)) {
      return value;
    }
    return buildHeadingFoldGutterClasses(tr.state);
  },
  provide: (field) => gutterLineClass.from(field),
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

function buildListFoldGutterClasses(
  state: EditorState,
  zones: readonly { from: number; to: number }[]
): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  let lastLineFrom = -1;
  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== "ListItem") {
        return;
      }
      const lineFrom = state.doc.lineAt(node.from).from;
      // Emit ONLY for lines that actually receive `.quoll-list-hang` padding, so
      // the gutter offset stays in lock-step with the content-line gap it
      // compensates for. buildListHangIndent (list-hang-indent.ts) skips two
      // cases and this MUST match them, else the chevron shifts without a matching
      // gap: (1) an exclusion zone — a frontmatter YAML list parses as markdown
      // ListItems but gets no hang, so a REVEALED frontmatter list would drop the
      // chevron ~0.6em; (2) `resolveListItemHang === null` — an empty / malformed
      // item, or an invalid-marker Task on a one-update-behind tree.
      if (pointInExclusionZone(lineFrom, zones)) {
        return;
      }
      if (resolveListItemHang(state, node.node) === null) {
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
      builder.add(lineFrom, lineFrom, LIST_FOLD_GUTTER_MARKER);
    },
  });
  return builder.finish();
}

/** Tags every list-item MARKER line with `quoll-fold-list-marker` on its gutter
 *  element via `gutterLineClass`, in lock-step with the `.cm-line.quoll-list-hang`
 *  padding it compensates for (same two-predicate eligibility gate — see
 *  buildListFoldGutterClasses). Recomputed when the doc, the parse tree
 *  (lang-markdown parses asynchronously), OR the `quollSyntaxExclusionZones`
 *  facet changes — the same doc/tree/facet triggers as listHangNeedsRebuild (its
 *  viewportChanged / selectionSet triggers do NOT apply here: this is a whole-doc
 *  StateField whose emitted set is selection-independent). The facet clause is
 *  parity/future-proofing — today no reachable transaction changes a zone's
 *  CONTENTS without also changing the doc — so it keeps the tag in lock-step if a
 *  future zone contributor flips on a selection-only edit. Exported for the
 *  marker-detection contract test. */
export const listFoldGutterLineClass = StateField.define<RangeSet<GutterMarker>>({
  create: (state) => buildListFoldGutterClasses(state, state.facet(quollSyntaxExclusionZones)),
  update(value, tr) {
    if (
      !tr.docChanged &&
      syntaxTree(tr.startState) === syntaxTree(tr.state) &&
      tr.startState.facet(quollSyntaxExclusionZones) === tr.state.facet(quollSyntaxExclusionZones)
    ) {
      return value;
    }
    return buildListFoldGutterClasses(tr.state, tr.state.facet(quollSyntaxExclusionZones));
  },
  provide: (field) => gutterLineClass.from(field),
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
 *  their chevron past the item's `--quoll-list-item-gap` top padding (PR #13). */
export function quollFolding(): Extension {
  return [
    codeFolding({ placeholderDOM: foldPlaceholderDOM }),
    headingFoldGutterLineClass,
    listFoldGutterLineClass,
    foldGutter({ markerDOM }),
    quollFoldKeymapExtension,
    quollFoldTheme,
  ];
}
