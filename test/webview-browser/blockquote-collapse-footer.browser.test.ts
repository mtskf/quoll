// Real-Chromium gate for the blockquote "Show more" bar's rendered geometry. happy-dom has
// no layout engine, so the facts the unit tests cannot see live here: the bar is the quote
// panel's visible footer, so its painted edges must line up with the quote rows', the
// row above an expanded bar must give up its rounding + external gap, the divider is a
// 1px ::before that stays inside the widget root, and a callout bar wears the rows' accent.
// Painted box = border box minus the TRANSPARENT gap/inset borders (each panel row clips its
// fill to the padding box), the same measurement fenced-adjacent-gap.browser.test.ts uses.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { codeFolding, foldEffect } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { blockStyle } from "../../src/webview/cm/decorations/block-style.js";
import { blockquoteCollapseField } from "../../src/webview/cm/decorations/blockquote-collapse.js";
import { calloutMarkerConcealField } from "../../src/webview/cm/decorations/callout-marker-conceal.js";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import {
  quollBlockStyleTheme,
  quollCmLinePaddingTheme,
  quollCollapseToggleTheme,
} from "../../src/webview/cm/theme.js";
import { settled } from "./helpers/frames.js";

let view: EditorView | undefined;
afterEach(() => {
  view?.destroy();
  view = undefined;
  for (const n of document.body.querySelectorAll(".cm-bq-collapse-probe")) {
    n.remove();
  }
});

function mount(doc: string, caret: number): EditorView {
  const parent = document.createElement("div");
  parent.className = "cm-bq-collapse-probe";
  parent.style.width = "500px";
  // The divider is a color-mix() over this token; undefined, the whole declaration is
  // invalid at computed-value time and the border collapses to 0 — a harness artefact.
  parent.style.setProperty("--vscode-foreground", "#cccccc");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(caret),
      extensions: [
        markdown({ base: markdownLanguage }),
        codeFolding(),
        quollSyntaxReveal(),
        blockStyle,
        calloutMarkerConcealField,
        blockquoteCollapseField,
        quollCmLinePaddingTheme,
        quollBlockStyleTheme,
        quollCollapseToggleTheme,
      ],
    }),
    parent,
  });
}

const px = (s: string): number => Number.parseFloat(s || "0");
interface Painted {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
function painted(el: HTMLElement): Painted {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  return {
    left: r.left + px(cs.borderLeftWidth),
    right: r.right - px(cs.borderRightWidth),
    top: r.top + px(cs.borderTopWidth),
    bottom: r.bottom - px(cs.borderBottomWidth),
  };
}
const lines = (n: number, prefix = "> "): string[] =>
  Array.from({ length: n }, (_, i) => `${prefix}q${i + 1}`);
const quoteRows = (v: EditorView): HTMLElement[] =>
  [...v.contentDOM.querySelectorAll<HTMLElement>(".cm-line.quoll-blockquote")].filter(
    (el) => el.getBoundingClientRect().height > 0
  );
const barOf = (v: EditorView): HTMLElement => {
  const bars = v.contentDOM.querySelectorAll<HTMLElement>(".quoll-blockquote-collapse-bar");
  expect(bars.length).toBe(1);
  return bars[0] as HTMLElement;
};
const click = async (v: EditorView): Promise<void> => {
  barOf(v).querySelector<HTMLElement>(".quoll-blockquote-collapse-toggle")?.click();
  await settled();
};

const PLAIN = `${lines(14).join("\n")}\n\npara`;
const OUTSIDE = (doc: string): number => doc.indexOf("para") + 1;

describe("blockquote collapse bar — rendered footer geometry (real Chromium)", () => {
  it("1. collapsed: bar edges match the rows, bottom corners rounded, no gap under row 10", async () => {
    view = mount(PLAIN, OUTSIDE(PLAIN));
    await settled();
    const bar = barOf(view);
    const rows = quoteRows(view);
    expect(rows.length).toBe(10);
    const last = painted(rows[9] as HTMLElement);
    const b = painted(bar);
    for (const row of rows) {
      expect(Math.abs(painted(row).left - b.left)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(painted(row).right - b.right)).toBeLessThanOrEqual(0.5);
    }
    const cs = getComputedStyle(bar);
    expect(px(cs.borderBottomLeftRadius)).toBeGreaterThan(0);
    expect(px(cs.borderBottomRightRadius)).toBeGreaterThan(0);
    expect(Math.abs(b.top - last.bottom)).toBeLessThanOrEqual(0.5);
  });

  it("2. expanded: last row un-rounded, no bottom border, flush with the bar; collapses back", async () => {
    view = mount(PLAIN, OUTSIDE(PLAIN));
    await settled();
    await click(view);
    const bar = barOf(view);
    expect(bar.classList.contains("quoll-blockquote-collapse-bar-collapsed")).toBe(false);
    const rows = quoteRows(view);
    expect(rows.length).toBe(14);
    const lastEl = rows[13] as HTMLElement;
    const cs = getComputedStyle(lastEl);
    expect(cs.borderBottomLeftRadius).toBe("0px");
    expect(cs.borderBottomRightRadius).toBe("0px");
    expect(cs.borderBottomWidth).toBe("0px");
    expect(Math.abs(painted(bar).top - painted(lastEl).bottom)).toBeLessThanOrEqual(0.5);
    expect(px(getComputedStyle(bar).borderBottomLeftRadius)).toBeGreaterThan(0);

    await click(view);
    expect(barOf(view).classList.contains("quoll-blockquote-collapse-bar-collapsed")).toBe(true);
    expect(quoteRows(view).length).toBe(10);
  });

  it("3. expanded quote ending in a concealed nested closing fence: no gap above the bar", async () => {
    const doc = `${[...lines(11), "> ```", "> code", "> ```"].join("\n")}\n\npara`;
    view = mount(doc, OUTSIDE(doc));
    await settled();
    await click(view);
    const bar = barOf(view);
    expect(bar.classList.contains("quoll-blockquote-collapse-bar-collapsed")).toBe(false);
    // Last VISIBLE quote row = the bar's nearest preceding sibling with height (the
    // concealed closing fence row is zero-height).
    let prev = bar.previousElementSibling as HTMLElement | null;
    while (prev && prev.getBoundingClientRect().height === 0) {
      prev = prev.previousElementSibling as HTMLElement | null;
    }
    expect(prev).not.toBeNull();
    expect((prev as HTMLElement).className, "row above the bar").toContain(
      "quoll-blockquote-close"
    );
    const cs = getComputedStyle(prev as HTMLElement);
    expect(cs.borderBottomLeftRadius).toBe("0px");
    expect(cs.borderBottomRightRadius).toBe("0px");
    expect(
      Math.abs(painted(bar).top - painted(prev as HTMLElement).bottom),
      "painted gap between last visible row and the bar"
    ).toBeLessThanOrEqual(0.5);
  });

  it("4. callout: the bar's accent box-shadow equals the rows', caret outside and inside", async () => {
    const doc = `${["> [!note]", ...lines(12)].join("\n")}\n\npara`;
    for (const caret of [OUTSIDE(doc), 12 /* inside the first body line → marker revealed */]) {
      view?.destroy();
      view = mount(doc, caret);
      await settled();
      const bar = barOf(view);
      const row = quoteRows(view).find((el) => el.classList.contains("quoll-callout"));
      expect(row).toBeDefined();
      const rowShadow = getComputedStyle(row as HTMLElement).boxShadow;
      expect(rowShadow).not.toBe("none");
      expect(getComputedStyle(bar).boxShadow).toBe(rowShadow);
    }
  });

  it("5. divider: 1px ::before, and no margin escapes the widget root", async () => {
    view = mount(PLAIN, OUTSIDE(PLAIN));
    await settled();
    const bar = barOf(view);
    expect(getComputedStyle(bar, "::before").borderTopWidth).toBe("1px");
    const rect = bar.getBoundingClientRect();
    // offsetHeight is rounded; a margin escaping the root would add whole pixels.
    expect(Math.abs(rect.height - bar.offsetHeight)).toBeLessThan(1);
    expect(getComputedStyle(bar).marginTop).toBe("0px");
    expect(getComputedStyle(bar).marginBottom).toBe("0px");
    // The next block (blank line then para) starts at bar bottom + the external gap
    // (the bar's own transparent bottom border is already inside its border box).
    const next = bar.nextElementSibling as HTMLElement;
    expect(next).not.toBeNull();
    expect(Math.abs(next.getBoundingClientRect().top - rect.bottom)).toBeLessThanOrEqual(0.5);
  });

  it("6. outer fold: folding the heading that owns an expanded quote removes the bar", async () => {
    const doc = `# H\n\n${lines(14).join("\n")}\n\n# Next\n\ntail`;
    view = mount(doc, doc.length);
    await settled();
    await click(view);
    expect(view.contentDOM.querySelectorAll(".quoll-blockquote-collapse-bar").length).toBe(1);
    const from = doc.indexOf("\n");
    const to = doc.indexOf("# Next") - 1;
    view.dispatch({ effects: foldEffect.of({ from, to }) });
    await settled();
    expect(view.contentDOM.querySelectorAll(".quoll-blockquote-collapse-bar").length).toBe(0);
  });
});
