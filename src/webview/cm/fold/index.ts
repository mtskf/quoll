// Quoll fold gutter: PURE UI activation of CM-core folding for Markdown.
//
// Heading folds come from Quoll's re-implementation of lang-markdown's headerIndent
// foldService (in cm/markdown.ts — re-implemented to avoid the markdown() wrapper's
// HTML stack); every other Block fold comes from lang-markdown's foldNodeProp on
// markdownLanguage.parser, MINUS a Blockquote/Paragraph/code-block subtraction that
// also lives in cm/markdown.ts (`nonFoldableBlocks`), NOT here. (lang-markdown folds headings via its
// headerIndent foldService AND every non-Document, non-heading Block — ListItem,
// Paragraph, Blockquote, fenced/indented code, GFM tables — via foldNodeProp. We
// override foldNodeProp for Blockquote + Paragraph + code blocks to null so prose
// blockquotes, standalone multi-line paragraphs, and code blocks show no chevron,
// while headings/lists/tables still fold. A foldService cannot subtract
// foldNodeProp — see cm/markdown.ts + docs/LEARNING.md.) This module only mounts
// the machinery:
//   - codeFolding({ placeholderDOM }) — foldState field + the INLINE placeholder
//                                 builder (foldPlaceholderDOM: the collapsed-region
//                                 pill, replacing CM's default grey box). foldGutter()
//                                 also bundles codeFolding() (harmless duplicate —
//                                 foldState is a singleton StateField), but the
//                                 placeholderDOM config must ride THIS explicit call.
//   - foldGutter({ markerDOM }) — the clickable chevron (a MOUSE affordance; the
//                                 gutter is aria-hidden by CM, so keyboard a11y
//                                 is foldKeymap below, not the marker's ARIA).
//   - keymap.of(foldKeymap)     — Ctrl-Shift-[ / ] (Cmd-Alt-[ / ] on mac) etc.
//   - gutterLineClass           — tags H1–H3 gutter lines so the theme can cap the
//                                 chevron at the right (taller) row height; see
//                                 headingFoldGutterLineClass + the theme note.
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

import { codeFolding, foldGutter, foldKeymap, syntaxTree } from "@codemirror/language";
import {
  type EditorState,
  type Extension,
  type RangeSet,
  RangeSetBuilder,
  StateField,
} from "@codemirror/state";
import { EditorView, GutterMarker, gutterLineClass, keymap } from "@codemirror/view";

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
 *  foldKeymap (Ctrl-Shift-[ / ]), the real a11y path. CM wires the click→toggle
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

/** The INLINE fold placeholder — the pill CM shows IN PLACE of a collapsed region
 *  (distinct from the gutter chevron `markerDOM` above). Replaces CM's default
 *  bordered-grey `.cm-foldPlaceholder` "…" box with a small circle filled with the
 *  blockquote surface tint, holding a knocked-out Lucide ellipsis (the dots are
 *  painted in the page background so they read as holes punched out of the pill).
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
// quollHighlightSpec: H1 1.6em / H2 1.4em / H3 1.2em). H4–H6 render at body size,
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
  // quollHighlightSpec H1 1.6em / H2 1.4em / H3 1.2em (cm/theme.ts).
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-1": { "--quoll-fold-row-scale": "1.6" },
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-2": { "--quoll-fold-row-scale": "1.4" },
  ".cm-foldGutter .cm-gutterElement.quoll-fold-heading-3": { "--quoll-fold-row-scale": "1.2" },
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
  // Inline fold placeholder (the collapsed-region pill; NOT the gutter chevron).
  // A small circle filled with the blockquote surface tint, holding a knocked-out
  // Lucide ellipsis — the dots are painted in the PAGE background (currentColor
  // below) so they read as holes punched out of the pill. Kept deliberately subtle
  // (the user pulled back from a green treatment). All three surfaces are
  // theme-following tokens so the pill tracks dark / light / HC automatically
  // (memory quoll-hc-theme-maps-to-light-theme-class):
  //   - fill = --quoll-surface-fill (the EXACT blockquote fill token; theme.ts's
  //     .quoll-blockquote uses the same var) with the shared textCodeBlock
  //     fallback so a pre-theme-class frame still shows a fill;
  //   - a 1px --quoll-surface-border edge (the surface family's border token):
  //     near-invisible against the fill in dark/light, but the visible
  //     contrastBorder in HC — where --quoll-surface-fill collapses to transparent
  //     (styles.css HC block) — so the pill stays a visible circle affordance in
  //     every theme;
  //   - dots = --vscode-editor-background (the page fill) via currentColor.
  // box-sizing:border-box keeps the 1px edge inside the 0.8em circle; a ~4px
  // inline-start margin lifts the pill off the fold's first-line text.
  ".quoll-fold-placeholder": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    boxSizing: "border-box",
    width: "0.8em",
    height: "0.8em",
    borderRadius: "50%",
    marginInlineStart: "4px",
    verticalAlign: "middle",
    cursor: "pointer",
    background:
      "var(--quoll-surface-fill, var(--vscode-textCodeBlock-background, rgba(255, 255, 255, 0.05)))",
    border: "1px solid var(--quoll-surface-border, transparent)",
    color: "var(--vscode-editor-background)",
  },
  ".quoll-fold-placeholder svg": {
    display: "block",
    width: "0.6em",
    height: "0.6em",
  },
});

/** The Quoll fold extension. Always on (no setting) — chevrons appear only on
 *  foldable lines. `headingFoldGutterLineClass` tags H1–H3 gutter lines so the
 *  theme can cap their chevron at the correct (taller) row height. */
export function quollFolding(): Extension {
  return [
    codeFolding({ placeholderDOM: foldPlaceholderDOM }),
    headingFoldGutterLineClass,
    foldGutter({ markerDOM }),
    keymap.of(foldKeymap),
    quollFoldTheme,
  ];
}
