// Real-browser gate for the caret-OFF list marker-gap LOCK-STEP. A rendered
// bullet's marker→text gap is delivered in two halves that must move together:
//   1. FIRST line — the `.quoll-bullet-marker` mark carries
//      `margin-right: var(--quoll-list-marker-gap, 0px)` (cm/theme.ts), pushing
//      the first-row content right by G after the dot.
//   2. CONTINUATION rows — list-hang-indent adds `+ var(--quoll-list-marker-gap)`
//      to BOTH text-indent and padding-inline-start (the `markerGap` term), so a
//      soft-wrap continuation hangs right by the same G while the first-line flow
//      origin (the dot) does not move.
// Both terms are GATED ON caret-OFF: bulletMarkerReveal emits the marked span
// only when no selection intersects the line, and the hang's markerGap term is
// `!revealed && (bullet || task)`. Same predicate, so the two halves flip in
// lock-step with the reveal.
//
// Why a NEW gate: the sibling list-hang-layout.browser.test.ts soft-wrap case
// mounts a single bullet with the DEFAULT caret at pos 0, which
// intersectsAnySelection (boundary-inclusive) treats as caret-ON — so
// listHangIndent's markerGap term resolves to "". That suite also never mounts
// bulletMarkerReveal/quollBulletMarkerTheme, so the `.quoll-bullet-marker` span
// and its first-line margin are absent there for a separate, structural reason
// (the provider isn't loaded), not caret gating. Either way that suite pins only
// the hang base + padding token; it does NOT exercise the caret-OFF marker-gap
// path. A production regression where the first-line marker margin
// and the continuation markerGap term drift apart (one consumes the token, the
// other stops) would still pass it. This file is that missing gate: it mounts
// the production bullet-reveal + bullet-marker theme, parks the caret OFF the
// measured bullet line, sets a DISTINCTIVE gap, and asserts both halves consume
// it in step. Real chromium only — happy-dom has no layout (coordsAtPos → null)
// and drops var()/calc() from getComputedStyle (memory quoll-happy-dom-*).
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { proseSpaceMetric } from "../../src/webview/cm/decorations/prose-space-metric.js";
import { listHangIndent } from "../../src/webview/cm/list/list-hang-indent.js";
import { quollBulletMarkerTheme, quollCmLinePaddingTheme } from "../../src/webview/cm/theme.js";

// Alignment tolerance. Monospace (see mount) degrades the marker-glyph blend to
// EXACT (`1ch == a space == the dash advance`) so first-row content and the
// wrapped continuation align to sub-pixel; a real lock-step break shifts one
// half by the WHOLE distinctive gap (40px), blowing past this. Mirrors
// list-hang-layout.browser.test.ts's BULLET_TOLERANCE_PX rationale.
const TOLERANCE_PX = 2;

// A distinctive marker gap, far larger than TOLERANCE_PX and any font residual,
// so a half that STOPS consuming the token misaligns by a glaring ~40px rather
// than a sub-pixel wobble. Chosen in px (not the production 0.5em) for a
// runner-deterministic delta.
const DISTINCTIVE_GAP_PX = 40;

// A long top-level bullet that soft-wraps at 300px monospace onto a 2nd visual
// row (same string/width as the sibling suite's wrap case), plus a trailing
// line to PARK THE CARET OFF the bullet. intersectsAnySelection is
// boundary-inclusive, so a caret at line 2's start (> line 1's `to`) leaves the
// bullet line caret-OFF — the state that renders the dot + engages markerGap.
const DOC =
  "- This is a fairly long bullet whose text must wrap onto a second visual row\ntrailing";

/** Resolve after CM's bounded measure queue drains (4-frame idiom shared with
 *  the sibling browser suites; proseSpaceMetric's one follow-up re-measure
 *  converges, so a small fixed frame count reads a settled height map). */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    let n = 4;
    const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  for (const n of document.body.querySelectorAll(".cm-marker-gap-probe")) {
    n.remove();
  }
});

/** Mount the PRODUCTION bullet-reveal + bullet-marker theme + hang, with the
 *  caret parked on the trailing line (bullet caret-OFF) and `--quoll-list-marker-gap`
 *  driven to `gapPx`. Monospace makes the marker-glyph blend exact (deterministic
 *  across runners). */
function mount(gapPx: number): EditorView {
  const parent = document.createElement("div");
  parent.className = "cm-marker-gap-probe";
  parent.style.width = "300px";
  parent.style.fontFamily = "monospace";
  document.body.appendChild(parent);
  const state = EditorState.create({ doc: DOC });
  return new EditorView({
    state: EditorState.create({
      doc: DOC,
      // Caret on line 2 → line 1 (the bullet) is caret-OFF.
      selection: EditorSelection.cursor(state.doc.line(2).from),
      extensions: [
        markdown({ base: markdownLanguage }),
        // Production order: proseSpaceMetric BEFORE listHangIndent (editor.ts).
        proseSpaceMetric,
        listHangIndent,
        quollCmLinePaddingTheme,
        // The caret-OFF marker dot + its first-line `margin-right` gap half.
        quollSyntaxReveal(),
        quollBulletMarkerTheme,
        EditorView.lineWrapping,
        // Drive the shared token to a distinctive value; custom properties
        // inherit from .cm-content to BOTH the `.quoll-bullet-marker` margin and
        // the `.cm-line` inline hang style. styles.css is not loaded here, so this
        // is the sole declaration (the `0px` fallback holds only when gapPx is 0).
        EditorView.theme({ ".cm-content": { "--quoll-list-marker-gap": `${gapPx}px` } }),
      ],
    }),
    parent,
  });
}

/** First-row content left and wrapped-continuation left, each RELATIVE to the
 *  bullet line's own box (so any probe placement offset cancels), after
 *  asserting the bullet line is caret-OFF, actually wrapped, and dot-rendered.
 *
 *  `contRel` is the LEFTMOST rendered glyph on the continuation row(s) — a true
 *  real-pixel read of where the soft-wrap hangs, NOT the CSS padding value. The
 *  first-row content (`coordsAtPos(2)`, just after `- `) must sit in that same
 *  column: caret-OFF, the marker's `margin-right: G` and the hang's `+G` term
 *  keep them locked as one column. */
function measure(v: EditorView): { firstRel: number; contRel: number } {
  const bulletLine = v.state.doc.line(1);
  // Caret-OFF precondition: the marked marker span must exist (it is emitted
  // ONLY caret-off). If this is absent the whole gate is vacuous.
  const marker = v.contentDOM.querySelector(".quoll-bullet-marker");
  expect(marker, "bullet marker dot must render (caret-OFF path)").not.toBeNull();

  const lineEl = v.contentDOM.querySelector(".cm-line") as HTMLElement;
  const lineLeft = lineEl.getBoundingClientRect().left;

  const firstRow = v.coordsAtPos(2); // just after `- `, always on the first visual row
  expect(firstRow).not.toBeNull();
  const firstBottom = (firstRow as { bottom: number }).bottom;

  // Scan every position on the bullet line; a glyph whose top drops below row 1
  // is on the continuation. Take the LEFTMOST such glyph = the rendered hang
  // column. Doubles as the wrap proof (contLeft stays Infinity if nothing wrapped).
  let contLeft = Number.POSITIVE_INFINITY;
  for (let pos = bulletLine.from; pos <= bulletLine.to; pos++) {
    const c = v.coordsAtPos(pos);
    if (c && c.top >= firstBottom - 0.5) {
      contLeft = Math.min(contLeft, c.left);
    }
  }
  expect(contLeft, "the bullet must soft-wrap onto a continuation row").toBeLessThan(
    Number.POSITIVE_INFINITY
  );
  return {
    firstRel: (firstRow as { left: number }).left - lineLeft,
    contRel: contLeft - lineLeft,
  };
}

describe("list marker-gap caret-off lock-step — real-pixel layout (browser gate)", () => {
  it("caret-OFF: first-row content stays aligned with the wrapped continuation under a distinctive gap", async () => {
    view = mount(DISTINCTIVE_GAP_PX);
    await settled();
    const { firstRel, contRel } = measure(view);
    // The primary visual contract: with a large marker gap engaged on BOTH
    // halves, the first row's content and its soft-wrap continuation still hang
    // in one column. If either half dropped the token they'd split by ~40px.
    expect(Math.abs(firstRel - contRel)).toBeLessThan(TOLERANCE_PX);
  });

  it("caret-OFF: the marker gap shifts BOTH the first-row margin and the continuation hang by the same amount (non-vacuity)", async () => {
    // NON-VACUITY + lock-step proof. Measure the caret-OFF bullet at gap 0 and at
    // the distinctive gap. If the first-line `margin-right` term were dropped, the
    // first row would NOT move (firstDelta ≈ 0); if the continuation `markerGap`
    // hang term were dropped, the continuation would NOT move (contDelta ≈ 0).
    // Requiring BOTH deltas ≈ the gap pins that each half consumes the token, and
    // requiring them EQUAL pins that they move in step (no drift).
    view = mount(0);
    await settled();
    const zero = measure(view);
    view.destroy();
    view = undefined;
    for (const n of document.body.querySelectorAll(".cm-marker-gap-probe")) {
      n.remove();
    }

    view = mount(DISTINCTIVE_GAP_PX);
    await settled();
    const gapped = measure(view);

    const firstDelta = gapped.firstRel - zero.firstRel;
    const contDelta = gapped.contRel - zero.contRel;
    // First-line marker margin actually consumed the token.
    expect(Math.abs(firstDelta - DISTINCTIVE_GAP_PX)).toBeLessThan(TOLERANCE_PX);
    // Continuation hang markerGap term actually consumed the token.
    expect(Math.abs(contDelta - DISTINCTIVE_GAP_PX)).toBeLessThan(TOLERANCE_PX);
    // Both halves moved by the SAME amount → in lock-step.
    expect(Math.abs(firstDelta - contDelta)).toBeLessThan(TOLERANCE_PX);
  });
});
