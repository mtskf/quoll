// CodeMirror base theme + markdown highlight, built on VS Code CSS
// variables (the same --vscode-* contract styles.css already consumes,
// so themes update with zero JS bridge). No reveal/widget styling yet
// — C1 is plain live-styled Markdown.
//
// CSP note (review fix #34): these are CodeMirror StyleModules — when an
// EditorView mounts them, CM injects <style> elements into document.head.
// The webview CSP forbids unsourced inline styles, so the EditorView is
// constructed with EditorView.cspNonce.of(nonce) (Task 4) and the host CSP
// admits 'nonce-${nonce}' on style-src (webview-html.ts). The nonce is
// per-resolve / runtime-only, so it is supplied at the EditorView, NOT
// baked into these module-level constants.
import { HighlightStyle, syntaxHighlighting, type TagStyle } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

export const quollTheme = EditorView.theme({
  "&": {
    color: "var(--vscode-editor-foreground)",
    backgroundColor: "var(--vscode-editor-background)",
    // Editor-preset font-size (outline settings popover). This "&" (.cm-editor)
    // declaration is the one that WINS for the editor text — an element's own
    // declaration beats inheritance, so setting it on .quoll-editor never
    // reached the content. Default preset = var removed → var(--vscode-font-size).
    fontSize: "var(--quoll-editor-font-size, var(--vscode-font-size))",
    height: "100%",
  },
  // .cm-content is the SINGLE owner of the reading column (review fix #40):
  // max-width + padding live HERE, not on the host .quoll-editor (whose
  // PM-era max-width:44em + padding:3.5rem 2.5rem 6rem were REMOVED in C1
  // — keeping both would double the measure and the insets).
  // Padding on .cm-content (CM-idiomatic) also lets the deep bottom inset
  // scroll WITH the text. Values carry the styles.css reading-column
  // intent (60em measure, deep bottom padding). Readonly dimming stays on
  // .quoll-editor.read-only (styles.css, @layer base) — do NOT dim
  // .cm-content too.
  ".cm-content": {
    // Editor-preset font-family (outline settings popover). Default = var
    // removed → var(--vscode-font-family), today's exact rendering.
    fontFamily: "var(--quoll-editor-font-family, var(--vscode-font-family))",
    caretColor: "var(--vscode-editorCursor-foreground)",
    // Group-centre the [foldGutter][content] pair so the fold chevron (cm/fold)
    // sits beside the reading column, not the viewport edge. Deterministic
    // flex-basis (not flex-grow free-space) so centring does not depend on
    // Chromium's leftover-space distribution: a 60em column that shrinks on
    // narrow panes, centred by `.cm-scroller { justify-content }` below.
    flexGrow: "0",
    flexShrink: "1",
    // Editor-preset content width (outline settings popover). Default = var
    // removed → 60em, today's exact reading column.
    flexBasis: "var(--quoll-editor-content-width, 60em)",
    maxWidth: "100%",
    padding: "3.5rem 2.5rem 6rem",
    // Body rhythm, tokenised. The value lives on :root as
    // --quoll-line-height (styles.css, base layer); the inline fallback
    // (1.7) keeps the declaration valid if the token is ever absent
    // (stylesheet load order / test env / a future sheet split) instead of
    // collapsing to an inherited value. A single token — or a
    // :root[data-quoll-theme="…"] override — retunes prose AND the block
    // widgets that inherit it. Without an explicit line-height the block
    // widgets compute their own, and the mismatch accumulates a click→caret
    // offset for every line below a widget.
    // Editor-preset line height (outline settings popover) layered ABOVE the
    // base --quoll-line-height token: default preset (Cozy) removes the var →
    // var(--quoll-line-height, 1.7), today's exact rhythm.
    lineHeight: "var(--quoll-editor-line-height, var(--quoll-line-height, 1.7))",
  },
  // The fold gutter (cm/fold) is ALWAYS mounted, so CM's view baseTheme paints
  // `.cm-gutters` with a grey background (#f5f5f5 light / #333338 dark) + a 1px
  // right border on EVERY line — an unwanted vertical band to the left of the
  // centred reading column. Neutralise the paint so an empty gutter column is
  // invisible whitespace (a chevron still shows beside foldable lines). The
  // border is zeroed on the SAME double-class selectors CM uses
  // (`.cm-gutters-before` / `.cm-gutters-after`) so this wins on specificity, not
  // just on EditorView.theme's cascade priority over baseTheme. Shared by the
  // opt-in lint gutter (same `.cm-gutters` wrapper) — also an improvement there.
  ".cm-gutters": {
    backgroundColor: "transparent",
  },
  ".cm-gutters.cm-gutters-before": {
    borderRightWidth: "0",
  },
  ".cm-gutters.cm-gutters-after": {
    borderLeftWidth: "0",
  },
  // Inter-list-item vertical breathing room. list-hang-indent.ts marks every
  // list-item MARKER line (the item's first line) with `.quoll-list-hang`, so a
  // top inset here separates consecutive bullet / ordered / task items without
  // touching intra-item continuation lines. Lives in this EditorView.theme (not
  // styles.css) for the same reason as blockStyleThemeSpec: only an unlayered,
  // editor-scoped CM theme beats CM's baseTheme `.cm-line { padding: 0 2px 0 6px }`
  // — and the two-class `.cm-line.quoll-list-hang` selector outranks that base
  // `.cm-line` on specificity. `padding-top` (not margin) keeps the gap INSIDE
  // the line box CodeMirror measures, so click→caret geometry stays accurate.
  // It is orthogonal to the decoration's INLINE `text-indent` / `padding-inline-start`
  // (horizontal hang), so nested-list alignment is untouched. Token retunes it
  // from :root (styles.css); display-only — the Markdown bytes never change.
  ".cm-line.quoll-list-hang": {
    paddingTop: "var(--quoll-list-item-gap, 0.5em)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--vscode-editorCursor-foreground)",
  },
  // Selection highlight: per-theme --quoll-selection-fill (styles.css) darkens
  // the DARK selection ~18% via color-mix while LIGHT/HC keep the plain host
  // colour; the --vscode-* fallback makes a pre-class frame degrade to the host
  // selection unchanged.
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "var(--quoll-selection-fill, var(--vscode-editor-selectionBackground))",
  },
  ".cm-scroller": { overflow: "auto", justifyContent: "safe center" },
});

// The single JS reference to the `.cm-line` start-padding token. Points at the
// EXISTING `--quoll-column-inset-left` (styles.css :root — see its comment there:
// the tokenised single-source mirror of CM's base `.cm-line` 6px left inset,
// already reserved by the fenced-code / blockquote / collapse-bar panels). The
// `.cm-line` padding rule below AND the list-hang decoration base (list-hang-indent.ts)
// both use THIS constant, so the line padding, the panels, and the hang base all
// derive from ONE source and can never silently drift. 6px fallback keeps
// token-less environments (unit tests) byte-compatible.
export const CM_LINE_START_PADDING = "var(--quoll-column-inset-left, 6px)";

// Quoll applies the shared column-inset token to the ACTUAL `.cm-line` left
// padding. CodeMirror's baseTheme sets `.cm-line { padding: 0 2px 0 6px }` (a
// private dist value); this closes the loop that styles.css's --quoll-column-inset-left
// comment describes — the panels already MIRROR that token, and now the line
// itself uses it too, so retuning the one :root token moves every inset together.
// An EditorView.theme (not styles.css) so the single-class `.cm-line` rule beats
// CM's unlayered baseTheme by cascade order (baseTheme is Prec.lowest-wrapped).
export const cmLinePaddingThemeSpec = {
  ".cm-line": {
    paddingLeft: CM_LINE_START_PADDING,
  },
};

export const quollCmLinePaddingTheme = EditorView.theme(cmLinePaddingThemeSpec);

// Markdown token styling. Lezer tags → CSS. Heading sizes give the
// Notion-ish hierarchy without rich nodes; the syntax marks stay
// visible (no reveal in C1).
// Exported so cm-decoration-block-style.test.ts can pin the navy+green token
// references on the spec OBJECT (same pattern as blockStyleThemeSpec) rather
// than a brittle source-text regex.
export const quollHighlightSpec: TagStyle[] = [
  // Headings: navy-blue structural accent (size/weight already differentiate level).
  {
    tag: t.heading1,
    fontSize: "1.8em",
    fontWeight: "700",
    color: "var(--quoll-accent-blue, var(--vscode-editor-foreground))",
  },
  {
    tag: t.heading2,
    fontSize: "1.5em",
    fontWeight: "700",
    color: "var(--quoll-accent-blue, var(--vscode-editor-foreground))",
  },
  {
    tag: t.heading3,
    fontSize: "1.2em",
    fontWeight: "600",
    color: "var(--quoll-accent-blue, var(--vscode-editor-foreground))",
  },
  {
    tag: [t.heading4, t.heading5, t.heading6],
    fontWeight: "600",
    color: "var(--quoll-accent-blue, var(--vscode-editor-foreground))",
  },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  // Inline code: a subtle navy pill. The monospace tag covers BOTH inline code
  // (InlineCode) AND fenced code text (CodeText) — see @lezer/markdown
  // "InlineCode CodeText": tags.monospace. So this background applies to inline
  // code in prose AND inside fenced blocks; inside a fenced block the same navy
  // is already painted by the .cm-line.quoll-fenced-code line background, so it
  // is seamless (identical colour). DELIBERATELY no padding: padding on an
  // inline token shifts CM's coordsAtPos and would skew click→caret; bg +
  // border-radius are paint-only and geometry-safe. Text colour is left as the
  // line foreground so multi-line fenced code stays fully legible.
  //
  // The box-shadow gives the pill ~2px of visual inset around the glyphs
  // WITHOUT layout impact: a spread-only shadow (0 offset, 0 blur, 2px spread)
  // in the same surface-fill paints a ring that extends the fill outward, so
  // glyphs no longer sit flush against the fill edge. It paints outside layout
  // (unlike padding) so coordsAtPos / click→caret metrics stay untouched.
  // Inside a fenced block the ring colour matches the line background, so it
  // stays seamless there too.
  //
  // Accepted trade-off: painting the fill OUTSIDE layout is the whole point
  // (padding would shift coordsAtPos), so the opaque ring necessarily bleeds
  // ~2px over anything directly abutting the token — the trailing glyph of a
  // no-space neighbour (`word`code`word`) or a selection highlight under the
  // pill. In practice the 2px lands mostly in inter-glyph whitespace so text
  // stays legible, and inline code is near-always space-delimited; any
  // horizontal-inset approach that avoids this would have to move layout,
  // which is exactly the geometry desync we are avoiding.
  {
    tag: [t.monospace],
    fontFamily: "var(--vscode-editor-font-family, monospace)",
    backgroundColor: "var(--quoll-surface-fill, transparent)",
    borderRadius: "3px",
    boxShadow: "0 0 0 2px var(--quoll-surface-fill, transparent)",
  },
  // Links: green content/action accent (clickability affordance is the cursor +
  // underline supplied elsewhere; colour is the accent).
  { tag: t.link, color: "var(--quoll-accent-green, var(--vscode-textLink-foreground))" },
  { tag: t.url, color: "var(--quoll-accent-green, var(--vscode-textLink-foreground))" },
  { tag: t.quote, color: "var(--vscode-descriptionForeground)" },
];

const quollHighlight = HighlightStyle.define(quollHighlightSpec);

export const quollHighlighting = syntaxHighlighting(quollHighlight);

// Style-FREE marker highlighter: emits STABLE class names on the two inline
// tokens whose look would otherwise be flattened by the nascent-setext reset
// (setext-nascent-reveal.ts + styles.css). Setting `class` makes CM emit NO CSS
// of its own (it uses `style.class || def(...)` — the generated-CSS branch is
// skipped), so this layer never affects normal rendering: it only tags spans.
// It rides the SAME shared treeHighlighter as quollHighlighting, so the class it
// emits is UNION'd onto the same span (`ͼstrong quoll-tok-strong`) — the seam
// styles.css's `.quoll-setext-nascent-raw .quoll-tok-*` keep-rules re-assert
// bold/link-colour against the reset. The two tokens mirror quollHighlightSpec's
// only weight/colour tokens (t.strong → font-weight; t.link/t.url → colour); the
// reset leaves font-style/text-decoration/background untouched, so italic /
// strikethrough / inline-code need no marker. Keyed on the SAME tags the visual
// spec uses, so "only what is bold/green today is kept" stays structurally in
// sync (no node-name duplication to drift). Mounted alongside quollHighlighting
// in editor.ts; pinned by cm-decoration-setext-nascent-render.test.ts.
export const TOK_STRONG_CLASS = "quoll-tok-strong";
export const TOK_LINK_CLASS = "quoll-tok-link";

export const quollTokenMarkers = syntaxHighlighting(
  HighlightStyle.define([
    { tag: t.strong, class: TOK_STRONG_CLASS },
    { tag: [t.link, t.url], class: TOK_LINK_CLASS },
  ])
);

// Shared elliptical corner radii + vertical breathing room for every rounded block
// EDGE — the fenced-code / blockquote OPEN (top) and CLOSE (bottom) fence lines, plus
// the collapse-bar footer (collapseBarFooterCorner below). Radii are ELLIPTICAL to
// compensate for `background-clip: padding-box` (see .quoll-fenced-code): the visible
// fill is the PADDING box, whose corner radius is the border-box radius MINUS the
// transparent alignment border. --quoll-block-radius is the wanted PAINTED round, so the
// border-box HORIZONTAL radius is bumped by that border width (`radius + 6px` left,
// `radius + 2px` right); the vertical borders are 0 here, so the vertical radius passes
// through as the token value. The vertical breathing room is --quoll-block-pad-y. All
// tokens are SHARED across the surfaces — retuning :root moves them together. Kept as a
// top/bottom factory (NOT a bottom-edge const reused directly) because the -open rules
// are the TOP-edge mirror. The 6px/2px inset literals live ONCE here; each edge variant
// is pinned by cm-decoration-block-style.test.ts / cm-fenced-code-collapse.test.ts.
//
// The EXTERNAL gap that separates a panel from the block directly above/below it is
// deliberately NOT here — it rides a SEPARATE, adjacency-gated rule (blockEdgeGapCorner
// below) applied only to the panel's TRUE outer boundary lines. It cannot live on this
// factory because -open/-close are applied to EVERY block node's first/last line,
// including a NESTED quote's inner line (`> > inner` carries quoll-blockquote-open while
// inside the outer panel — see block-style.ts) — a gap there would punch a transparent
// strip through the middle of the parent panel.
const blockEdgeLeftRadius =
  "calc(var(--quoll-block-radius, 8px) + var(--quoll-column-inset-left, 6px)) var(--quoll-block-radius, 8px)";
const blockEdgeRightRadius =
  "calc(var(--quoll-block-radius, 8px) + var(--quoll-column-inset-right, 2px)) var(--quoll-block-radius, 8px)";
const blockEdgeCorner = (edge: "top" | "bottom"): Record<string, string> =>
  edge === "top"
    ? {
        borderTopLeftRadius: blockEdgeLeftRadius,
        borderTopRightRadius: blockEdgeRightRadius,
        paddingTop: "var(--quoll-block-pad-y, 12px)",
      }
    : {
        borderBottomLeftRadius: blockEdgeLeftRadius,
        borderBottomRightRadius: blockEdgeRightRadius,
        paddingBottom: "var(--quoll-block-pad-y, 12px)",
      };

// EXTERNAL vertical gap on a panel's TRUE outer boundary line — a TRANSPARENT vertical
// border sourced from --quoll-block-gap-y. The panel surfaces paint with
// `background-clip: padding-box`, so the transparent border renders the editor background
// through it (a real gap) WITHOUT a `.cm-line` margin (which would break CM's line
// geometry — a border, like padding, stays inside the box CM measures, so posAtCoords
// stays accurate; heading-rhythm padding precedent). Because the border is on the SAME
// axis the fill clips to, it ALSO eats the painted vertical corner radius the same way the
// horizontal alignment border eats the horizontal one — so the vertical radius term is
// bumped by --quoll-block-gap-y here (mirroring the `+ inset` horizontal compensation on
// blockEdge*Radius) to keep the painted corner a true --quoll-block-radius round. Applied
// ONLY via adjacency-gated selectors (a -open line NOT preceded by a same-panel line, a
// -close line NOT followed by one) so nested/continuation edges inside a panel are
// untouched. Pinned by cm-decoration-block-style.test.ts.
const blockEdgeGap = "var(--quoll-block-gap-y, 8px) solid transparent";
const blockEdgeGapLeftRadius =
  "calc(var(--quoll-block-radius, 8px) + var(--quoll-column-inset-left, 6px)) calc(var(--quoll-block-radius, 8px) + var(--quoll-block-gap-y, 8px))";
const blockEdgeGapRightRadius =
  "calc(var(--quoll-block-radius, 8px) + var(--quoll-column-inset-right, 2px)) calc(var(--quoll-block-radius, 8px) + var(--quoll-block-gap-y, 8px))";
const blockEdgeGapCorner = (edge: "top" | "bottom"): Record<string, string> =>
  edge === "top"
    ? {
        borderTop: blockEdgeGap,
        borderTopLeftRadius: blockEdgeGapLeftRadius,
        borderTopRightRadius: blockEdgeGapRightRadius,
      }
    : {
        borderBottom: blockEdgeGap,
        borderBottomLeftRadius: blockEdgeGapLeftRadius,
        borderBottomRightRadius: blockEdgeGapRightRadius,
      };

// Fenced-code panel + blockquote rule styling for the block-style.ts line
// decorations. Lives HERE (an EditorView.theme), NOT styles.css: CM's base
// theme sets `.cm-line { padding: 0 2px 0 6px }` UNLAYERED, which beats
// every layered styles.css rule (see styles.css header) — only another
// unlayered CM theme can override the line padding. Two wins stack: CM
// gives EditorView.theme rules higher precedence than baseTheme, AND the
// two-class `.cm-line.<class>` selectors outrank baseTheme's single-class
// `.cm-line` on specificity (both selectors gain the editor-scope prefix CM
// injects). Values mirror Markdown Studio's `pre` / `blockquote` treatment;
// token colours stay owned by quollHighlight above, so no syntax palette is
// duplicated here.
//
// Kept as a SEPARATE theme extension (not merged into quollTheme) so the
// spec stays exportable as a plain object — cm-decoration-block-style.test.ts
// pins the contract directly (EditorView.theme returns an opaque Extension).
// Merging into quollTheme (Codex Conf 91) would save one registration line
// but lose the testable export and mix block-decoration styling into the
// structural base theme; the single-responsibility split is preferred.
export const blockStyleThemeSpec = {
  // Fenced-code panel: theme-aware subtle background, monospace, slightly
  // smaller. Horizontal padding overrides CM's 6px/2px line padding.
  ".cm-line.quoll-fenced-code": {
    // Navy surface tint; host + hard fallbacks retained for the pre-theme-class frame.
    backgroundColor:
      "var(--quoll-surface-fill, var(--vscode-textCodeBlock-background, rgba(255, 255, 255, 0.05)))",
    fontFamily: "var(--vscode-editor-font-family, monospace)",
    fontSize: "0.9em",
    boxSizing: "border-box",
    // Body-text-column alignment — see the shared rationale on .quoll-blockquote
    // below. Transparent 6px/2px borders reserve CM's base `.cm-line` text inset
    // and `background-clip: padding-box` paints the tint only inside them, so the
    // fill lands flush with paragraph text without moving the line's layout box.
    // The --quoll-block-pad-x interior padding then insets the code within the panel
    // (a SHARED token with the blockquote below so the two surfaces never drift). The
    // vertical inset is the separate --quoll-block-pad-y (tighter than the horizontal),
    // applied on the -open/-close edge lines only.
    borderLeft: "var(--quoll-column-inset-left, 6px) solid transparent",
    borderRight: "var(--quoll-column-inset-right, 2px) solid transparent",
    backgroundClip: "padding-box",
    paddingLeft: "var(--quoll-block-pad-x, 16px)",
    paddingRight: "var(--quoll-block-pad-x, 16px)",
  },
  // Round the top + add top breathing room only on the opening fence line — the shared
  // elliptical corner spec (blockEdgeCorner; its doc comment explains the padding-box
  // radius compensation and the SHARED --quoll-block-* tokens).
  ".cm-line.quoll-fenced-code-open": blockEdgeCorner("top"),
  // Round the bottom + bottom breathing room only on the closing fence line
  // (blockEdgeCorner's bottom mirror).
  ".cm-line.quoll-fenced-code-close": blockEdgeCorner("bottom"),
  // Blockquote: subtle navy fill + muted text. The fill lands on every quote
  // line so the panel is continuous; horizontal padding insets the text from
  // the fill's edges.
  ".cm-line.quoll-blockquote": {
    // The subtle navy fill alone affords "this is a quote"; text stays muted
    // (descriptionForeground) since a quote is secondary. (The former green
    // left rule was removed 2026-07-01 — the fill carries the affordance.)
    backgroundColor: "var(--quoll-surface-fill, transparent)",
    // Body-text-column alignment (2026-07-01 overflow re-report; SHARED contract
    // for .quoll-fenced-code and .quoll-fenced-collapse-bar). The navy fill is a
    // .cm-line background. A .cm-line is width:auto inside the centred .cm-content
    // reading column, so its border-box exactly fills .cm-content's CONTENT box —
    // it never overflows the column container. BUT CodeMirror's base
    // `.cm-line { padding: 0 2px 0 6px }` insets BODY text by 6px left / 2px right,
    // and a border-box-clipped fill ignores that inset, so it would sit 6px/2px
    // OUTSIDE the body-text column and read as "wider than paragraphs". (#225's
    // added padding only moved the panel's INNER text; it never moved the fill
    // edges — box-sizing:border-box is a no-op while width is auto, so the bleed
    // survived.) FIX: reserve that base inset as a TRANSPARENT 6px/2px border and
    // paint the tint only inside it via `background-clip: padding-box`. The fill
    // then lands exactly on the body-text column — flush with paragraphs and list
    // items on BOTH edges — WITHOUT shrinking the line's layout box (the border-box
    // stays full width, so CM's line geometry and the block-widget `margin:0`
    // height invariant are both untouched; a horizontal margin was rejected for
    // that reason). Left/right borders add no vertical height, and hit-testing is
    // unchanged, so posAtCoords stays glyph-accurate. The --quoll-block-pad-x interior
    // padding (SHARED with the fenced-code panel above; the tighter vertical inset is
    // --quoll-block-pad-y on the -open/-close lines) then insets the quote text
    // within the panel; box-sizing:border-box keeps the border+padding inside a
    // future explicit width. See the -open/-close corners
    // for the elliptical-radius compensation the clip requires. Pinned by
    // cm-decoration-block-style.test.ts; real-pixel alignment + click→caret
    // accuracy are verified in the browser harness (happy-dom has no layout —
    // fenced-collapse precedent).
    boxSizing: "border-box",
    borderLeft: "var(--quoll-column-inset-left, 6px) solid transparent",
    borderRight: "var(--quoll-column-inset-right, 2px) solid transparent",
    backgroundClip: "padding-box",
    paddingLeft: "var(--quoll-block-pad-x, 16px)",
    paddingRight: "var(--quoll-block-pad-x, 16px)",
    color: "var(--vscode-descriptionForeground, var(--vscode-editor-foreground))",
  },
  // Round the top corners on the opening quote line, mirroring the fenced-code panel
  // — same shared elliptical corner spec (blockEdgeCorner). Real-pixel geometry is
  // checked in the browser harness (happy-dom has no layout — fenced-collapse precedent).
  ".cm-line.quoll-blockquote-open": blockEdgeCorner("top"),
  // Round the bottom corners on the closing quote line (blockEdgeCorner's bottom mirror).
  ".cm-line.quoll-blockquote-close": blockEdgeCorner("bottom"),
  // EXTERNAL gap at the quote/callout panel's TRUE top boundary: a -open line NOT
  // immediately preceded by another quote line (blockEdgeGapCorner adds the transparent
  // border + vertical-radius compensation). A nested/continuation -open (`> > inner`,
  // whose previous rendered sibling is the outer `> …` line and so carries
  // .quoll-blockquote) is excluded by the `:not(… + …)`, so no transparent strip splits
  // the parent panel. Callouts inherit this — their lines carry quoll-blockquote-open too
  // (and a concealed-marker callout migrates -open onto the first body line, whose
  // previous sibling is the zero-height marker row, which is facet-excluded from
  // block-style and so carries no .quoll-blockquote — the gap still lands). Higher
  // specificity than the base -open rule above, so the compensated radii win.
  //
  // The gating reads RENDERED `.cm-line` siblings, not document lines — CM virtualises the
  // viewport, so at the render boundary a nested inner -open's preceding same-panel line
  // may be absent from the DOM, letting the `:not()` misfire and add a spurious strip.
  // In practice that is bounded to the render edge, which sits ~1000px offscreen (CM's
  // default viewportMargin, not overridden here) and CM renders a CONTIGUOUS line range —
  // so the only affected line is the offscreen first/last rendered one, never a visible
  // nested boundary. A fully viewport-independent version would emit an explicit
  // outer-boundary class from the block-style.ts builder (document-model driven); tracked
  // as a follow-up. See docs/TODO.md.
  ".cm-line.quoll-blockquote-open:not(.cm-line.quoll-blockquote + .cm-line.quoll-blockquote-open)":
    blockEdgeGapCorner("top"),
  // EXTERNAL gap at the TRUE bottom boundary: a -close line NOT immediately followed by
  // another quote line (a nested/continuation close is followed by the outer `> …` line).
  ".cm-line.quoll-blockquote-close:not(:has(+ .cm-line.quoll-blockquote))":
    blockEdgeGapCorner("bottom"),
  // Nested-quote deeper tint (block-style.ts blockquoteDepthClass). A `> >` /
  // `> > >` line carries `quoll-blockquote-depth-{2,3}` ON TOP of the base
  // .quoll-blockquote class; these override ONLY the fill, deepening it per level
  // so nesting reads visually. color-mix toward the editor FOREGROUND lifts the
  // fill's contrast against the base depth-1 band in BOTH themes (dark fg is
  // light → the band brightens; light fg is dark → it darkens) — either way the
  // nested band stands out more. Same two-class specificity as .quoll-blockquote,
  // so source order (these come AFTER) is what makes the deeper fill win; all
  // other panel props (border / padding / radius / text colour) still come from
  // the base rule. A high-contrast theme sets --quoll-surface-fill: transparent,
  // so the mix stays near-transparent there — nesting leans on the contrast
  // border, matching the base panel's HC treatment. (color-mix precedent:
  // --quoll-selection-fill in styles.css.)
  ".cm-line.quoll-blockquote-depth-2": {
    backgroundColor:
      "color-mix(in srgb, var(--quoll-surface-fill, transparent), var(--vscode-editor-foreground) 7%)",
  },
  ".cm-line.quoll-blockquote-depth-3": {
    backgroundColor:
      "color-mix(in srgb, var(--quoll-surface-fill, transparent), var(--vscode-editor-foreground) 14%)",
  },
  // Callout admonitions (classification in decorations/callout.ts). An OUTERMOST
  // blockquote whose first line is `[!TYPE]` carries `quoll-callout
  // quoll-callout-{type}` on every line (+ `quoll-callout-marker` on the REVEALED
  // marker row; the row is concealed when the caret is outside the block).
  // The callout reuses the blockquote panel WHOLESALE — the plain shared
  // --quoll-surface-fill background and the body-column alignment (the transparent
  // 6px/2px border + `background-clip: padding-box`, both inherited from
  // .quoll-blockquote) — and adds ONLY a thin per-type accent bar: a 2px INSET
  // box-shadow painted at the fill's LEFT edge, so the accent sits INSIDE the
  // reading column flush with the fill. A box-shadow (not a coloured border) is
  // used deliberately: colouring the 6px alignment border put the bar in the left
  // gutter OUTSIDE the column, reading as both too thick and as horizontal
  // overflow; the inset shadow lands on the padding-box edge WITHOUT shifting the
  // shared alignment, so line geometry / posAtCoords stay glyph-accurate. The fill
  // is now identical to a normal blockquote (in HC --quoll-surface-fill is
  // transparent, so the accent leans on the box-shadow bar there — matching the
  // depth-class HC handling; VS Code HC is class-based, not OS forced-colors, so
  // the shadow renders). Placed AFTER the depth rules so a nested callout's first
  // line still gets the accent (the box-shadow is orthogonal to the depth fill).
  // Colours are self-adapting VS Code semantic tokens matching GitHub's semantics
  // (note=blue, tip=green, important=purple, warning=amber, caution=red).
  ".cm-line.quoll-callout": {
    boxShadow: "inset 2px 0 0 0 var(--quoll-callout-accent)",
  },
  ".cm-line.quoll-callout-note": {
    "--quoll-callout-accent":
      "var(--vscode-editorInfo-foreground, var(--vscode-charts-blue, #3794ff))",
  },
  ".cm-line.quoll-callout-tip": {
    "--quoll-callout-accent":
      "var(--vscode-charts-green, var(--vscode-terminal-ansiGreen, #3fb950))",
  },
  ".cm-line.quoll-callout-important": {
    "--quoll-callout-accent": "var(--vscode-charts-purple, #a371f7)",
  },
  ".cm-line.quoll-callout-warning": {
    "--quoll-callout-accent":
      "var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow, #d29922))",
  },
  ".cm-line.quoll-callout-caution": {
    "--quoll-callout-accent":
      "var(--vscode-editorError-foreground, var(--vscode-charts-red, #f85149))",
  },
  // The REVEALED marker line (the `[!TYPE]` line, caret inside the block) reads as
  // a header — the accent bar + this weighted marker line carry the callout type,
  // so no per-type emoji badge is painted (it was redundant on the minimal axis).
  ".cm-line.quoll-callout-marker": {
    fontWeight: "600",
  },
  // A CONCEALED marker line (caret OUTSIDE the callout): the callout-marker-conceal
  // StateField replaces the whole `[!TYPE]` row and tags it with this class.
  // Collapse it to zero height so no blank padded row remains — the `-open` corner
  // rides the first visible body line instead. Copies the five zero-height
  // props of `.quoll-fenced-code-fence-hidden` below. Placed NEXT to that rule but
  // BEFORE it so the fence-hidden rule stays the LAST spec key (its defensive
  // source-order guard); no specificity conflict exists — a concealed marker line
  // is facet-excluded from block-style, so it never co-carries `-open`/padding.
  ".cm-line.quoll-callout-marker-hidden": {
    height: "0",
    minHeight: "0",
    paddingTop: "0",
    paddingBottom: "0",
    lineHeight: "0",
  },
  // A CONCEALED fence row (its ``` content is replaced by fenced-code-reveal, so
  // the line is empty). Collapse it to zero height so no blank padded row remains;
  // the panel's rounded corners + 0.75em vertical padding ride the adjacent BODY
  // line instead (see block-style.ts fencedCodeLineClasses). `line-height: 0`
  // collapses the empty strut; font-size is deliberately NOT set here —
  // copyButtonThemeSpec sets it to 0.9em on this same class so the copy button's
  // em-based sizing matches the revealed state (Codex #2). NO `overflow: hidden` —
  // it would clip the out-of-flow copy button, which extends below this zero-height
  // row to overlay the first body line. `position: relative` is NOT here either —
  // it is owned by copyButtonThemeSpec (the anchor's theme), see below.
  //
  // Kept AFTER the .quoll-blockquote-open/-close rules (Codex #1) as a DEFENSIVE
  // source-order guard. The original concern: a blockquote-NESTED fence's
  // collapsed row carrying BOTH this class AND quoll-blockquote-open/-close,
  // whose 8px vertical padding has EQUAL specificity (.cm-line.<class>) —
  // CodeMirror emits theme rules in object-key order, so this rule's `padding*: 0`
  // only wins by coming later. Since the blockquote edge migration (block-style.ts)
  // now moves -open/-close OFF a concealed boundary fence onto the adjacent visible
  // body line, that co-occurrence no longer happens — so this ordering is now
  // belt-and-suspenders (kept for defence, and because the pure-fenced collapsed
  // row's padding zeroing is unconditional regardless).
  ".cm-line.quoll-fenced-code-fence-hidden": {
    height: "0",
    minHeight: "0",
    paddingTop: "0",
    paddingBottom: "0",
    lineHeight: "0",
  },
};

export const quollBlockStyleTheme = EditorView.theme(blockStyleThemeSpec);

// Bullet-list marker dot (bullet-marker-reveal.ts). The provider marks the raw
// `-`/`*`/`+` glyph with `.quoll-bullet-marker` on every bullet line the caret
// is NOT on; this hides the glyph and paints a round dot in its place. An
// EditorView.theme (NOT styles.css) so it beats CM's unlayered baseTheme /
// syntax-highlight rules on the same span — see the header note on
// blockStyleThemeSpec. Display-only: the glyph byte stays in the document and
// its advance width is preserved (color: transparent keeps the glyph box), so
// the content column and list-hang-indent geometry never shift between the
// dotted and revealed (caret-on) states.
//
// Dot colour is the Quoll-owned --quoll-bullet-marker token (styles.css): the
// existing accent green on dark, a brighter green on light (chosen 2026-07-02
// via Chrome design preview + user pick), re-pointed to the host accent in
// high-contrast. Exported as a plain object so
// cm-decoration-bullet-marker-theme.test.ts pins the contract directly
// (EditorView.theme returns an opaque Extension); real-pixel geometry + per-theme
// colour are verified in the real editor (happy-dom has no layout).
export const bulletMarkerThemeSpec = {
  ".quoll-bullet-marker": {
    // Hide the raw dash/star/plus glyph WITHOUT removing it from layout — the
    // char keeps its advance width, so revealing it (caret-on) never shifts the
    // content column. `position: relative` anchors the ::before marker.
    color: "transparent",
    position: "relative",
    // First-line half of the marker → text gap (list-marker-restyle). The span
    // exists only caret-off (bulletMarkerReveal emits nothing caret-on), so this is
    // auto-gated; the continuation half is the list-hang provider's gap term. The
    // ::before marker is position:absolute, so it does not move with this margin.
    marginRight: "var(--quoll-list-marker-gap, 0px)",
  },
  // Shared ::before positioning for every depth. Shape / size / paint live on the
  // per-depth selectors below so the marker varies by nesting depth (Obsidian-style
  // cue): d1 = filled dot (larger), d2 = hollow dot, d3+ = a dash bar. `left: 0`
  // lands the marker's left edge on the text-column edge (contained; a negative
  // `left` bleeds past it). position:absolute → purely visual, no layout shift, so
  // the raw glyph's advance and the list-hang content column are unchanged.
  ".quoll-bullet-marker::before": {
    content: '""',
    position: "absolute",
    left: "0",
    top: "50%",
    transform: "translateY(-50%)",
    pointerEvents: "none",
  },
  // Depth 1: a filled disc, slightly larger than the pre-restyle 0.34em. Size is
  // the --quoll-bullet-dot-size token (styles.css) so it stays tunable in one place.
  ".quoll-bullet-marker-d1::before": {
    width: "var(--quoll-bullet-dot-size, 0.6em)",
    height: "var(--quoll-bullet-dot-size, 0.6em)",
    borderRadius: "50%",
    backgroundColor: "var(--quoll-bullet-marker, var(--vscode-textLink-foreground))",
  },
  // Depth 2: a hollow disc (outline only) — same footprint as d1, no fill.
  ".quoll-bullet-marker-d2::before": {
    width: "var(--quoll-bullet-dot-size, 0.6em)",
    height: "var(--quoll-bullet-dot-size, 0.6em)",
    borderRadius: "50%",
    backgroundColor: "transparent",
    border:
      "var(--quoll-bullet-hollow-border, 2px) solid var(--quoll-bullet-marker, var(--vscode-textLink-foreground))",
    boxSizing: "border-box",
  },
  // Depth 3 and deeper: a short dash bar (a horizontal rule, not a disc) — a
  // geometry-stable glyph substitute, same philosophy as the checkbox tick.
  ".quoll-bullet-marker-d3::before": {
    width: "var(--quoll-bullet-dash-width, 0.5em)",
    height: "var(--quoll-bullet-dash-height, 2px)",
    borderRadius: "1px",
    backgroundColor: "var(--quoll-bullet-marker, var(--vscode-textLink-foreground))",
  },
};

export const quollBulletMarkerTheme = EditorView.theme(bulletMarkerThemeSpec);

// Heading vertical rhythm (heading-rhythm.ts). The ViewPlugin marks every
// rhythm-eligible heading line (top-level, not line 1, not in a frontmatter
// zone) with `.quoll-heading-rhythm-{level}`, so a per-LEVEL top inset adds
// Notion-style breathing room ABOVE the heading. Lives in this EditorView.theme
// (NOT styles.css) for the SAME reason as .quoll-list-hang: only an unlayered,
// editor-scoped CM theme beats CM's baseTheme `.cm-line { padding: 0 2px 0 6px }`,
// and the two-class `.cm-line.quoll-heading-rhythm-*` selector outranks that base
// `.cm-line` on specificity. `padding-top` (not margin) keeps the gap INSIDE the
// line box CodeMirror measures, so click→caret geometry stays accurate. The `em`
// tokens resolve against the BODY font (heading font-size lives on the token
// spans via HighlightStyle, not on `.cm-line`). Per-level values are tokenised on
// :root (styles.css), grouping h4-h6 like quollHighlightSpec; the inline fallback
// keeps the declaration valid if the token is ever absent. Display-only — the
// Markdown bytes never change. Exported as a plain spec so
// cm-decoration-heading-rhythm.test.ts pins the contract (EditorView.theme
// returns an opaque Extension), like bulletMarkerThemeSpec.
export const headingRhythmThemeSpec = {
  ".cm-line.quoll-heading-rhythm-1": {
    paddingTop: "var(--quoll-heading-space-1, 1.2em)",
  },
  ".cm-line.quoll-heading-rhythm-2": {
    paddingTop: "var(--quoll-heading-space-2, 1em)",
  },
  ".cm-line.quoll-heading-rhythm-3": {
    paddingTop: "var(--quoll-heading-space-3, 0.75em)",
  },
  // h4/h5/h6 share one tighter token — they render at body font-size, so a single
  // smaller inset reads consistently (mirrors quollHighlightSpec grouping them).
  ".cm-line.quoll-heading-rhythm-4, .cm-line.quoll-heading-rhythm-5, .cm-line.quoll-heading-rhythm-6":
    {
      paddingTop: "var(--quoll-heading-space-4, 0.5em)",
    },
};

export const quollHeadingRhythmTheme = EditorView.theme(headingRhythmThemeSpec);

// Completed-task CONTENT mute (checkbox-completed-tint feature). task-checkbox-reveal.ts
// emits a Decoration.mark carrying `.quoll-task-completed-content` over a checked task's
// content span (marker line, caret off it). This recedes the text to a muted ink so
// incomplete items dominate. An EditorView.theme (NOT styles.css) so it is pinnable as an
// exported spec object (bulletMarkerThemeSpec precedent). It overrides the INHERITED
// content foreground for plain text; coloured syntax tokens inside a completed item (e.g. a
// link) keep their own token colour — plain body text is the dominant case and this mutes
// it. DELIBERATELY colour-only — NO line-through: the approved design mutes, it does not
// strike. Ink is the Quoll-owned --quoll-completed-ink token (styles.css theme blocks; HC
// keeps full foreground).
export const taskCompletedContentThemeSpec = {
  ".quoll-task-completed-content": {
    color: "var(--quoll-completed-ink, var(--vscode-descriptionForeground, inherit))",
  },
};

export const quollTaskCompletedContentTheme = EditorView.theme(taskCompletedContentThemeSpec);

// Copy-code button overlay for fenced code blocks (fenced-code-copy-button.ts).
// Separate EditorView.theme (not styles.css) for the same reason as
// blockStyleThemeSpec: it must beat CodeMirror's UNLAYERED baseTheme `.cm-line`
// rules, and only another unlayered, editor-scoped CM theme can. The button is
// position:absolute and the open fence line is position:relative, so the button
// anchors to the panel's top-right corner. The button is out of flow; height
// invariance of the open fence line (accounting for CM's inline `.cm-widgetBuffer`)
// is confirmed by the real-browser smoke. Exported as a plain spec so
// cm-fenced-code-copy-button.test.ts can pin the contract.
// Shared FG + hover-BG for the two fenced-code panel controls — the copy button
// (copyButtonThemeSpec) and the "Show N more lines" collapse toggle
// (collapseToggleThemeSpec) — so the pair reads as a set. Single source of truth:
// retune here and both controls move together (never duplicate the literals). The
// foreground is the neutral token both specs already fell back to; the hover tint
// is the toolbar-control background the collapse bar already used. Correct in both
// light and dark.
const fencedControlForeground = "var(--vscode-foreground)";
const fencedControlHoverBackground =
  "var(--vscode-toolbar-hoverBackground, rgba(255, 255, 255, 0.1))";

export const copyButtonThemeSpec = {
  // The open fence line is the panel's top row; making it the positioning
  // context lets the absolutely-positioned button pin to the panel top-right.
  ".cm-line.quoll-fenced-code-open": {
    position: "relative",
  },
  // The COLLAPSED open fence line still hosts the copy-button widget DOM (it is
  // anchored by document position at the open fence line.from). Keep it a
  // positioning context so the absolutely-positioned button still pins to the
  // panel's top-right after the row collapses to zero height. Same `position:
  // relative` the revealed `.quoll-fenced-code-open` line carries above.
  //
  // `font-size: 0.9em` matches the revealed open fence line (which inherits
  // `.quoll-fenced-code { font-size: 0.9em }`): the button's geometry (top/right/
  // padding/svg) is em-based, so without this the collapsed line would inherit the
  // ~1em body size and the button would resize/shift ~10% each time the caret
  // enters/leaves the fence (Codex #2). Safe for the collapse — `line-height: 0`
  // (blockStyleThemeSpec) keeps the empty line box at zero regardless of font-size.
  ".cm-line.quoll-fenced-code-fence-hidden": {
    position: "relative",
    fontSize: "0.9em",
  },
  // Icon-only button: the bare Lucide glyph with NO resting background — inline-flex
  // centres the SVG; the glyph is sized in em so it tracks the panel font. The
  // resting state is the dimmed icon alone (--quoll-control-rest-opacity); the boxed affordance
  // (borderRadius fill) appears only on hover/focus, so at rest the button reads as
  // an icon, not a bordered box.
  //
  // `backgroundColor: transparent` is set EXPLICITLY, not merely omitted: this is a
  // real `<button>`, and the VS Code webview injects a default `button { background:
  // var(--vscode-button-background) }` rule. Omitting the property here would let
  // that default paint the primary-button fill at rest — so the icon-only look
  // requires actively neutralising it, exactly as the sibling webview buttons
  // (.quoll-outline-toggle / .quoll-switch-editor-toggle) each set their own
  // explicit `background`.
  //
  // `appearance/border/boxShadow: none` neutralise the resting EDGE for the same
  // reason: a native `<button>` carries a raised-key bevel (native `appearance`) and
  // the injected default may add a `border`/`box-shadow`. Left un-reset, that edge
  // highlight gives the bare icon a heavier "raised key" weight at rest. The boxed
  // affordance is meant to appear only on hover/focus (the tint below), so the
  // resting button must read as a flat icon — hence explicitly stripping all three.
  ".quoll-copy-button": {
    position: "absolute",
    top: "0.3em",
    right: "0.4em",
    zIndex: "1",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "0.2em",
    color: fencedControlForeground,
    appearance: "none",
    backgroundColor: "transparent",
    border: "none",
    boxShadow: "none",
    borderRadius: "4px",
    cursor: "pointer",
    // Shared floating-control resting dim + fade (styles.css :root). Fallback
    // mirrors the token default for the pre-stylesheet frame.
    opacity: "var(--quoll-control-rest-opacity, 0.6)",
    transition: "var(--quoll-control-transition, opacity 0.12s ease)",
    userSelect: "none",
  },
  ".quoll-copy-button svg": {
    display: "block",
    width: "1em",
    height: "1em",
  },
  ".quoll-copy-button:hover, .quoll-copy-button:focus-visible": {
    opacity: "1",
    backgroundColor: fencedControlHoverBackground,
  },
  ".quoll-copy-button.is-copied": {
    opacity: "1",
    color:
      "var(--vscode-testing-iconPassed, var(--vscode-button-foreground, var(--vscode-foreground)))",
  },
  ".quoll-copy-button.is-copy-failed": {
    opacity: "1",
    color: "var(--vscode-errorForeground, var(--vscode-foreground))",
  },
};

export const quollCopyButtonTheme = EditorView.theme(copyButtonThemeSpec);

// "Show more" / "Show less" collapse bar for long fenced code blocks
// (fenced-code-collapse-widget.ts). Separate EditorView.theme (not styles.css) for
// the same reason as copyButtonThemeSpec: it must beat CodeMirror's UNLAYERED
// baseTheme `.cm-line` rules. The bar is a full-width clickable row that blends
// with the code panel (same navy surface tint as .cm-line.quoll-fenced-code) so it
// reads as part of the block, set slightly dimmer until hover. Exported as a plain
// spec so cm-fenced-code-collapse.test.ts can pin the contract. Height/placement
// are verified in the real-browser harness (not assertable in happy-dom).
// The rounded, padded footer edge shared by the collapse bar's TWO footer states —
// the collapsed "Show more" bar AND the expanded "Show less" bar when it is the panel's
// visible bottom. Both draw the same bottom edge as .cm-line.quoll-fenced-code-close via
// the shared blockEdgeCorner spec (see its doc comment), so the three footers can never
// drift.
const collapseBarFooterCorner = blockEdgeCorner("bottom");

export const collapseToggleThemeSpec = {
  ".quoll-fenced-collapse-bar": {
    backgroundColor:
      "var(--quoll-surface-fill, var(--vscode-textCodeBlock-background, rgba(255, 255, 255, 0.05)))",
    // Body-text-column alignment: mirror the .cm-line.quoll-fenced-code inset so the
    // bar's fill lines up with the code panel above it (without this the bar — a
    // block widget that is NOT a .cm-line — would keep its full-width fill and jut
    // 6px/2px past the inset panel). Same transparent-border + background-clip trick
    // as the fenced-code panel: it insets the paint without touching the widget's
    // getBoundingClientRect HEIGHT (left/right borders add no vertical height; the
    // `margin:0` block-widget invariant is about VERTICAL height). See the shared
    // rationale on .quoll-blockquote.
    borderLeft: "var(--quoll-column-inset-left, 6px) solid transparent",
    borderRight: "var(--quoll-column-inset-right, 2px) solid transparent",
    backgroundClip: "padding-box",
    paddingLeft: "var(--quoll-block-pad-x, 16px)",
    paddingRight: "var(--quoll-block-pad-x, 16px)",
  },
  // COLLAPSED-state footer: in the collapsed state the closing fence line falls
  // inside the Decoration.replace concealed range (buildFencedCollapse), so this
  // "Show more" bar is the panel's visible bottom. It reads as a finished rounded
  // panel via the shared footer corner. State class (`-collapsed`) toggled by
  // FencedCollapseToggleWidget.toDOM.
  //
  // The collapsed conceal range (buildFencedCollapse via fencedBlockGeometry.collapseTo)
  // EXTENDS over the closing fence line, so a caret parked ON the closing fence counts
  // as inside the concealed region and AUTO-EXPANDS the block (the same auto-unfold a
  // caret on a hidden body line triggers — no new rebuild trigger; the existing
  // selectionEntersCollapsed fast path fires because the block-replace now covers the
  // fence). A collapsed block therefore can NEVER simultaneously show this rounded
  // Show-more footer AND a revealed rounded `.quoll-fenced-code-close` below it: the
  // transient double-round is structurally impossible, not merely tolerated.
  ".quoll-fenced-collapse-bar-collapsed": collapseBarFooterCorner,
  // EXPANDED-state footer. The "Show less" bar is a `side:1` block widget planted
  // AFTER the last body line (buildFencedCollapse, at concealTo), so the row directly
  // BELOW it is the closing fence — which is either REVEALED (caret in the block, its
  // ``` row carries a rounded `.quoll-fenced-code-close`) or CONCEALED (caret out, its
  // row collapses to the zero-height `.quoll-fenced-code-fence-hidden` and block-style
  // migrates `-close` UP onto the last body line, i.e. the row ABOVE the bar). The
  // earlier design assumed the rounded closing edge always sat BELOW the bar, but in
  // the concealed (caret-out) case — the DEFAULT after "Show more" — it migrates ABOVE
  // it, leaving the square bar jutting under the rounded panel (the reported bug).
  //
  // Fix, driven purely by the rendered adjacency (no field↔block-style coupling): make
  // the bar the rounded footer UNLESS a revealed closing fence sits directly below it
  // (then that fence is the footer and the bar stays a flat interior row). `:has(+ …)`
  // reads the next rendered sibling; the bar and its neighbours are direct .cm-content
  // children with no interposed .cm-widgetBuffer (verified in the browser harness), so
  // the adjacency combinator is reliable. Covers unclosed blocks too (no closing fence
  // below → the bar always rounds). Real-pixel geometry + dark/light verified in the
  // browser harness (happy-dom has no layout — fenced-collapse precedent).
  ".quoll-fenced-collapse-bar:not(.quoll-fenced-collapse-bar-collapsed):not(:has(+ .cm-line.quoll-fenced-code-close))":
    collapseBarFooterCorner,
  // …and when the bar IS that footer, the last body line directly above it must NOT
  // also round — otherwise block-style's migrated `-close` (caret-out) and this bar
  // both round, double-rounding an interior row. Un-round exactly the code row that
  // sits immediately above an expanded (non-collapsed) bar. Higher specificity than
  // block-style's base `.cm-line.quoll-fenced-code-close`, so this wins.
  ".cm-line.quoll-fenced-code-close:has(+ .quoll-fenced-collapse-bar:not(.quoll-fenced-collapse-bar-collapsed))":
    {
      borderBottomLeftRadius: "0",
      borderBottomRightRadius: "0",
      paddingBottom: "0",
    },
  ".quoll-fenced-collapse-toggle": {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35em",
    padding: "0.15em 0.4em",
    margin: "0.1em 0",
    fontSize: "0.85em",
    fontFamily: "var(--vscode-font-family, sans-serif)",
    color: fencedControlForeground,
    background: "none",
    border: "none",
    borderRadius: "4px",
    cursor: "pointer",
    // Shared floating-control resting dim + fade (styles.css :root); the collapse
    // toggle previously had no transition, so it now fades on hover like the rest.
    opacity: "var(--quoll-control-rest-opacity, 0.6)",
    transition: "var(--quoll-control-transition, opacity 0.12s ease)",
  },
  ".quoll-fenced-collapse-toggle:hover, .quoll-fenced-collapse-toggle:focus-visible": {
    opacity: "1",
    backgroundColor: fencedControlHoverBackground,
  },
  ".quoll-fenced-collapse-toggle svg": {
    display: "block",
    width: "1em",
    height: "1em",
  },
};

export const quollCollapseToggleTheme = EditorView.theme(collapseToggleThemeSpec);

// Find & replace panel (@codemirror/search) styling. An EditorView.theme (NOT
// styles.css) BY NECESSITY: @codemirror/search injects its panel baseTheme
// UNLAYERED, and styles.css is fully @layer-scoped — a layered rule can never
// beat an unlayered baseTheme declaration regardless of specificity (see
// styles.css cascade note). EditorView.theme is also unlayered AND beats
// baseTheme in CM's cascade, so this reliably retints the panel to the VS Code
// look while keeping every colour a --vscode-* passthrough (no hard-coded
// palette). Selectors target the search panel's stable CM class names.
export const searchPanelThemeSpec = {
  ".cm-panel.cm-search": {
    padding: "6px 8px",
    backgroundColor: "var(--vscode-editorWidget-background, var(--vscode-editor-background))",
    color: "var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground))",
    borderBottom: "1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, #888))",
    fontFamily: "var(--vscode-font-family)",
  },
  ".cm-panel.cm-search .cm-textfield": {
    fontSize: "var(--vscode-font-size)",
    color: "var(--vscode-input-foreground, inherit)",
    backgroundColor: "var(--vscode-input-background, transparent)",
    border: "1px solid var(--vscode-input-border, var(--vscode-editorWidget-border, #888))",
    borderRadius: "2px",
    padding: "2px 4px",
  },
  ".cm-panel.cm-search .cm-textfield:focus-visible": {
    outline: "1px solid var(--vscode-focusBorder)",
    outlineOffset: "-1px",
  },
  ".cm-panel.cm-search .cm-button": {
    fontSize: "var(--vscode-font-size)",
    color: "var(--vscode-button-secondaryForeground, var(--vscode-button-foreground))",
    backgroundColor: "var(--vscode-button-secondaryBackground, var(--vscode-button-background))",
    backgroundImage: "none",
    border: "1px solid transparent",
    borderRadius: "2px",
    padding: "2px 8px",
  },
  ".cm-panel.cm-search .cm-button:hover": {
    backgroundColor:
      "var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground))",
  },
  ".cm-panel.cm-search label": {
    fontSize: "var(--vscode-font-size)",
    color: "var(--vscode-editorWidget-foreground, var(--vscode-editor-foreground))",
  },
  ".cm-panel.cm-search [name=close]": {
    color: "var(--vscode-icon-foreground, var(--vscode-editor-foreground))",
    cursor: "pointer",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33))",
  },
  ".cm-searchMatch-selected": {
    backgroundColor: "var(--vscode-editor-findMatchBackground, rgba(234, 92, 0, 0.66))",
  },
  // highlightSelectionMatches() injects a hardcoded baseTheme with
  // `.cm-selectionMatch { backgroundColor: "#99ff7780" }` (fixed green).
  // Override it here with the VS Code selection-highlight token so the colour
  // stays on-theme in dark/light/High Contrast modes.
  ".cm-selectionMatch": {
    backgroundColor: "var(--vscode-editor-selectionHighlightBackground, rgba(173, 214, 255, 0.15))",
  },
  // When a selectionMatch sits inside a searchMatch the base already provides
  // `transparent`; repeat it here so this theme wins regardless of load order.
  ".cm-searchMatch .cm-selectionMatch": {
    backgroundColor: "transparent",
  },
};

export const quollSearchPanelTheme = EditorView.theme(searchPanelThemeSpec);
