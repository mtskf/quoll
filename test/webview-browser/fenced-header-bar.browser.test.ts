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
  quollLanguagePickerTheme,
} from "../../src/webview/cm/theme.js";

/** Drain CM's bounded measure queue (4-frame idiom shared with the sibling browser
 *  suites) so getBoundingClientRect / getComputedStyle read a settled layout. */
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
        quollLanguagePickerTheme,
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

  it("conceal↔reveal keeps the label aligned with the copy button — no vertical OR horizontal jump", async () => {
    // Compare vertical CENTRES (what reads as "one row"): the label wrapper is the
    // full strip height with centred text; the copy button is a small button — their
    // tops differ by design, their centres are what must line up.
    const midY = (r: DOMRect) => (r.top + r.bottom) / 2;

    view = mount(TAGGED, TAGGED.indexOf("para") + 1); // concealed
    await settled();
    const cLab = (label(view) as HTMLElement).getBoundingClientRect();
    const cCopy = (copy(view) as HTMLElement).getBoundingClientRect();
    // Vertical: label and copy centres share the strip band (the gap-offset fix).
    expect(Math.abs(midY(cLab) - midY(cCopy))).toBeLessThanOrEqual(3);

    view.dispatch({ selection: { anchor: 2 } }); // caret onto the fence → revealed
    await settled();
    const rLab = (label(view) as HTMLElement).getBoundingClientRect();
    const rCopy = (copy(view) as HTMLElement).getBoundingClientRect();
    expect(Math.abs(midY(rLab) - midY(rCopy))).toBeLessThanOrEqual(3);

    // The label must not jump horizontally between the two states (the column-inset
    // fix for the border-less fence-hidden row).
    expect(Math.abs(cLab.left - rLab.left)).toBeLessThanOrEqual(3);
  });
});
