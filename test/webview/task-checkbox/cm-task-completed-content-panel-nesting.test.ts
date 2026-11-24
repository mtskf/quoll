// @vitest-environment happy-dom
// Pins WHO paints a completed task's text inside a quote / callout panel: the `t.quote`
// highlight span nests INSIDE the `.quoll-task-completed-content` mark and wraps every
// text run, so QUOTE_INK (not the completed-ink token) reaches the glyphs there. A fix
// aimed at the completed-ink token alone is therefore a no-op inside a panel (the
// A11Y-15 misdiagnosis). Outside a panel the mark holds the text directly and paints it.
import { highlightingFor } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quollSyntaxReveal } from "../../../src/webview/cm/decorations/index.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import {
  quollHighlighting,
  quollTaskCompletedContentTheme,
  quollTokenMarkers,
} from "../../../src/webview/cm/theme.js";
import { settledMount } from "../helpers/settled-view.js";

vi.mock("../../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage: vi.fn() }),
  subscribeToHost: () => () => {},
}));

const MARK = "quoll-task-completed-content";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.replaceChildren();
});

// Trailing `tail` paragraph holds the caret so every task marker line is off-caret
// (the reveal only mutes a checked task whose marker line the caret is not on).
function mount(body: string): EditorView {
  const doc = `${body}\n\ntail`;
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = settledMount({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(doc.length),
      extensions: [
        quollMarkdownLanguage(),
        quollHighlighting,
        quollTokenMarkers,
        quollTaskCompletedContentTheme,
        quollSyntaxReveal(),
      ],
    }),
  });
  return view;
}

// Derived from the live highlighters, never hard-coded (the class names are generated).
function quoteClasses(v: EditorView): string[] {
  const cls = highlightingFor(v.state, [tags.quote]);
  expect(cls, "t.quote must resolve to a highlight class").toBeTruthy();
  return (cls ?? "").split(" ").filter(Boolean);
}

function marks(v: EditorView): HTMLElement[] {
  const found = [...v.contentDOM.querySelectorAll<HTMLElement>(`.${MARK}`)];
  expect(found.length, "a completed-content mark must render").toBeGreaterThan(0);
  return found;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
    if ((n.textContent ?? "").trim() !== "") {
      out.push(n as Text);
    }
  }
  return out;
}

function hasClasses(el: Element, classes: string[]): boolean {
  return classes.every((c) => el.classList.contains(c));
}

// Nearest element between the text node and the mark (exclusive) carrying the t.quote
// highlight class — the element whose `color` the glyph actually inherits.
function quoteSpanBelowMark(text: Text, mark: HTMLElement, classes: string[]): Element | null {
  for (let el = text.parentElement; el !== null && el !== mark; el = el.parentElement) {
    if (hasClasses(el, classes)) {
      return el;
    }
  }
  return null;
}

describe("completed-task text inside a panel is painted by the t.quote span, not the mark", () => {
  it.each([
    ["quote", "> - [x] ship it **bold** [l](http://x.y)"],
    ["nested quote", "> > - [x] nested"],
    ["callout", "> [!NOTE]\n> - [x] callout done"],
  ])("%s: every glyph sits under a t.quote span nested inside the mark", (_label, body) => {
    const v = mount(body);
    const classes = quoteClasses(v);
    for (const mark of marks(v)) {
      const texts = textNodes(mark);
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(
          text.parentElement,
          `"${text.textContent}" must not be a direct mark child`
        ).not.toBe(mark);
        expect(
          quoteSpanBelowMark(text, mark, classes),
          `"${text.textContent}" must inherit its colour from a t.quote span inside the mark`
        ).not.toBeNull();
      }
    }
  });
});

describe("control: outside a panel the mark paints the text itself", () => {
  it("a plain completed item keeps its text as a direct mark child", () => {
    const v = mount("- [x] plain done");
    const classes = quoteClasses(v);
    for (const mark of marks(v)) {
      const direct = [...mark.childNodes].filter(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== ""
      );
      expect(direct.map((n) => n.textContent?.trim())).toEqual(["plain done"]);
      expect(mark.querySelector(`.${classes.join(".")}`)).toBeNull();
    }
  });
});
