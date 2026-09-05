// Real-browser gate for the ChatGPT-style header bar on language-tagged fenced
// blocks. happy-dom has no layout and drops calc()/var() (memories
// quoll-happy-dom-no-layout-cssom-drops-calc / quoll-webview-css-bug-real-browser-harness),
// so the header's REAL geometry — reserved top padding, the icon+language label on
// the LEFT vs the copy button on the RIGHT, and their alignment ACROSS the
// reveal/conceal migration (the two anchoring asymmetries the :has(+ …) + column-
// inset offsets in fencedHeaderBarThemeSpec correct) — can only be checked here.
// styles.css is not loaded, so every --quoll-* token resolves to its in-spec
// fallback (header height 2.1em, gap-y 8px, column inset 6px), which is exactly the
// production geometry we want to pin.
//
// The second suite below pins the VERTICAL half of that correction across every
// nesting/conceal combination. It is the only place the bug it guards can be seen:
// the panel's painted top edge is its padding-box top (background-clip: padding-box
// over a transparent --quoll-block-gap-y border), and only a layout engine reports
// where that lands. Before concealedGapAnchor generalised the offset off the language
// tag, a bare concealed block put the copy button 4px ABOVE the paint (over the
// rounded corner) while its tagged twin sat 4px inside.
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { blockStyle } from "../../src/webview/cm/decorations/block-style.js";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { fencedCodeCopyButton } from "../../src/webview/cm/fenced-code/fenced-code-copy-button.js";
import { fencedCodeLanguagePicker } from "../../src/webview/cm/fenced-code/fenced-code-language-picker.js";
import {
  quollBlockStyleTheme,
  quollCmLinePaddingTheme,
  quollCopyButtonTheme,
  quollFencedHeaderBarTheme,
} from "../../src/webview/cm/theme.js";
import { settled } from "./helpers/frames.js";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  for (const n of document.body.querySelectorAll(".cm-header-bar-probe")) {
    n.remove();
  }
});

function mount(doc: string, caret: number): EditorView {
  const parent = document.createElement("div");
  parent.className = "cm-header-bar-probe";
  parent.style.width = "600px";
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [
        markdown({ base: markdownLanguage }),
        quollSyntaxReveal(),
        blockStyle,
        fencedCodeLanguagePicker,
        fencedCodeCopyButton,
        quollCmLinePaddingTheme,
        quollBlockStyleTheme,
        quollCopyButtonTheme,
        quollFencedHeaderBarTheme,
      ],
    }),
    parent,
  });
}

const label = (v: EditorView) =>
  v.contentDOM.querySelector<HTMLElement>(".quoll-language-picker-label.is-labeled");
const copy = (v: EditorView) => v.contentDOM.querySelector<HTMLElement>(".quoll-copy-button");
const hasLangLine = (v: EditorView) =>
  v.contentDOM.querySelector<HTMLElement>(".quoll-fenced-code-has-language");

const TAGGED = "```js\nconst a = 1;\nconst b = 2;\n```\n\npara";

describe("fenced-code header bar — real-pixel layout", () => {
  it("language-tagged block: reserves header height, label LEFT of copy, both in the strip", async () => {
    // Caret parked on the trailing paragraph → concealed (the common reading state).
    view = mount(TAGGED, TAGGED.indexOf("para") + 1);
    await settled();
    const line = hasLangLine(view);
    const lab = label(view);
    const cp = copy(view);
    expect(line, "has-language line must render").not.toBeNull();
    expect(lab, "labelled picker must render").not.toBeNull();
    expect(cp, "copy button must render").not.toBeNull();

    const padTop = Number.parseFloat(getComputedStyle(line as HTMLElement).paddingTop);
    expect(padTop, "header height reserved as top padding").toBeGreaterThan(20);

    const lr = (lab as HTMLElement).getBoundingClientRect();
    const cr = (cp as HTMLElement).getBoundingClientRect();
    expect(lr.left, "language label is left of the copy button").toBeLessThan(cr.left);

    // Both controls sit inside the reserved strip band above the code.
    const band = (line as HTMLElement).getBoundingClientRect();
    for (const r of [lr, cr]) {
      expect(r.top).toBeGreaterThanOrEqual(band.top - 2);
      expect(r.top).toBeLessThan(band.top + padTop + 2);
    }
  });

  it("bare (language-less) block: no reserved strip, no labelled wrapper", async () => {
    view = mount("```\nconst a = 1;\n```\n\npara", 20);
    await settled();
    expect(hasLangLine(view)).toBeNull();
    expect(label(view)).toBeNull();
  });

  it("concealed: label centre aligns with the copy button (one row); revealed: header hides", async () => {
    // Compare vertical CENTRES (what reads as "one row"): the label wrapper is the
    // full strip height with centred text; the copy button is a small button — their
    // tops differ by design, their centres are what must line up.
    const midY = (r: DOMRect) => (r.top + r.bottom) / 2;
    const shown = (el: HTMLElement | null) => el !== null && el.getClientRects().length > 0;

    view = mount(TAGGED, TAGGED.indexOf("para") + 1); // concealed (reading mode)
    await settled();
    expect(shown(label(view)), "label shown in reading mode").toBe(true);
    const cLab = (label(view) as HTMLElement).getBoundingClientRect();
    const cCopy = (copy(view) as HTMLElement).getBoundingClientRect();
    // Vertical: label and copy centres share the strip band (the gap-offset fix).
    expect(Math.abs(midY(cLab) - midY(cCopy))).toBeLessThanOrEqual(3);

    view.dispatch({ selection: { anchor: 2 } }); // caret onto the fence → revealed
    await settled();
    // Header hides in edit mode — the raw ```lang line is shown instead.
    expect(shown(label(view)), "label hidden while editing").toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Copy-button vertical inset vs the panel's PAINTED top edge.
// ---------------------------------------------------------------------------

/** The painted top edge of the panel the control belongs to: the padding-box top of
 *  the panel's visible open-edge line. The fill is `background-clip: padding-box`, so
 *  a transparent --quoll-block-gap-y top border is NOT painted — the surface starts
 *  that much below the border box. Walking forward from the control's own anchor line
 *  to the first `-open` line pairs each control with ITS panel (adjacent blocks). */
function paintedPanelTop(view: EditorView, control: HTMLElement): number {
  const lines = [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")];
  const anchor = control.closest(".cm-line") as HTMLElement | null;
  for (let i = anchor === null ? 0 : lines.indexOf(anchor); i < lines.length; i++) {
    const line = lines[i] as HTMLElement;
    if (line.classList.contains("quoll-fenced-code-open")) {
      return (
        line.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(line).borderTopWidth)
      );
    }
  }
  throw new Error("no visible fenced open edge for this control");
}

/** How far the copy button's top sits INSIDE the painted panel top. Positive = inside
 *  (correct); negative = hanging over the panel's rounded top edge (the bug). */
function copyInsets(view: EditorView): number[] {
  return [...view.contentDOM.querySelectorAll<HTMLElement>(".quoll-copy-button")].map(
    (cp) => cp.getBoundingClientRect().top - paintedPanelTop(view, cp)
  );
}

// `top: 0.3em` at the fence-hidden row's 0.9em-of-16px font ≈ 4px. Pinning the band
// (not the float) keeps the test about the CONTRACT — the button is inset by the
// declared 0.3em, not the gap-sized 8px-off datum a missing correction produces
// (-4px) nor a doubled one (+12px) — while tolerating sub-pixel font rounding.
const EXPECTED_INSET = 4;
const TOLERANCE = 1.5;

describe("copy button sits INSIDE the painted panel top in every concealed nesting", () => {
  // Each case is a doc whose caret parks OUTSIDE every fenced block (reading mode →
  // concealed fences), except where the name says otherwise. The bug this pins was
  // concealed-only: revealed anchors are the bordered open line itself.
  const cases: Array<{ name: string; doc: string; caret?: number; expected?: number }> = [
    { name: "bare block, concealed (the reported bug)", doc: "```\nconst a = 1;\n```\n\npara" },
    { name: "language-tagged block, concealed", doc: "```js\nconst a = 1;\n```\n\npara" },
    { name: "bare block, revealed", doc: "```\nconst a = 1;\n```\n\npara", caret: 2 },
    { name: "language-tagged block, revealed", doc: "```js\nconst a = 1;\n```\n\npara", caret: 2 },
    // Blockquote-nested: block-style suppresses the FENCED outer-open inside a quote
    // and the QUOTE's outer-open supplies the identical gap border instead — the
    // second source concealedGapAnchor has to cover.
    {
      name: "blockquote-nested bare block, concealed",
      doc: "> ```\n> const a = 1;\n> ```\n\npara",
    },
    {
      name: "blockquote-nested tagged block, concealed",
      doc: "> ```js\n> const a = 1;\n> ```\n\npara",
    },
    {
      name: "list-nested bare block, concealed",
      doc: "- item\n\n  ```\n  const a = 1;\n  ```\n\npara",
    },
    // Bodyless: no body line for the edges to migrate onto, so the open fence line
    // keeps the panel itself — already-correct states that must not gain a second
    // offset from the widened selector.
    { name: "bodyless bare block", doc: "```\n```\n\npara" },
    { name: "bodyless tagged block (header-only bar)", doc: "```js\n```\n\npara" },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      view = mount(c.doc, c.caret ?? c.doc.indexOf("para") + 1);
      await settled();
      const insets = copyInsets(view);
      expect(insets, "one copy button per fenced block").toHaveLength(1);
      const inset = insets[0] as number;
      expect(inset, "button top is below the painted panel top").toBeGreaterThan(0);
      expect(Math.abs(inset - EXPECTED_INSET), `inset ${inset}px`).toBeLessThanOrEqual(TOLERANCE);
    });
  }

  // Two directly-adjacent blocks collapse to ONE gap: the SECOND block yields its
  // -outer-open, so its open edge has NO gap border and needs NO correction. Pins the
  // adjacency gate itself — a correction applied unconditionally would push this one
  // 8px too low.
  it("directly-adjacent pair: both buttons land at the same inset", async () => {
    const doc = "```\na\n```\n```\nb\n```\n\npara";
    view = mount(doc, doc.indexOf("para") + 1);
    await settled();
    const insets = copyInsets(view);
    expect(insets, "one copy button per block").toHaveLength(2);
    for (const inset of insets) {
      expect(inset).toBeGreaterThan(0);
      expect(Math.abs(inset - EXPECTED_INSET), `inset ${inset}px`).toBeLessThanOrEqual(TOLERANCE);
    }
  });
});
