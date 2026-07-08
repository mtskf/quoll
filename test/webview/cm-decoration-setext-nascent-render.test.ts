// @vitest-environment happy-dom
//
// Behavioural (computed-style) proof that the nascent-setext de-style actually
// wins the cascade against the REAL quollHighlighting rule — not just that the
// decoration is emitted (that is cm-decoration-setext-nascent.test.ts) and not
// just that the CSS text exists (styles-contract.test.ts).
//
// happy-dom does no layout, but it DOES resolve non-layout font-size cascade
// (including `em` → px against the root size), which is all this asserts. The
// one caveat that made this possible: the override CSS is UNLAYERED — happy-dom
// ignores `@layer` blocks entirely, so a layered rule would be invisible here
// (and the real fix would read as broken). The rule sits unlayered in styles.css
// for exactly this reason (see the comment there). Real-pixel confirmation is
// still a browser-harness smoke; this is the CI guard that the em heading size
// is defeated.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { quollSyntaxReveal } from "../../src/webview/cm/decorations/index.js";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { quollHighlighting } from "../../src/webview/cm/theme.js";

vi.mock("../../src/webview/host.js", () => ({
  getHost: () => ({ postMessage: vi.fn() }),
  subscribeToHost: () => () => {},
}));

const BODY_PX = 14;

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(doc.length),
      extensions: [quollMarkdownLanguage(), quollHighlighting, quollSyntaxReveal()],
    }),
  });
}

/** Computed font-size (px) of the deepest span carrying the given text on the
 *  first `.cm-line` — i.e. the size the reader actually sees for that glyph run. */
function titleFontPx(view: EditorView, text: string): number {
  const line = view.contentDOM.querySelector(".cm-line");
  const spans = [...(line?.querySelectorAll("span") ?? [])];
  const target = spans.reverse().find((s) => s.textContent?.includes(text)) ?? line;
  const fs = target ? getComputedStyle(target as Element).fontSize : "";
  return Number.parseFloat(fs);
}

describe("nascent-setext de-style — computed size against the real highlight", () => {
  // Inject the real webview stylesheet + a definite body font-size token so the
  // heading `em` and the reset both resolve to comparable px.
  const style = document.createElement("style");
  // cwd is the repo root under vitest; happy-dom's import.meta.url is an http
  // URL, so resolve from cwd instead of import.meta.url.
  const cssPath = resolve(process.cwd(), "src/webview/styles.css");
  style.textContent = `${readFileSync(cssPath, "utf8")}\n:root{--vscode-font-size:${BODY_PX}px}`;
  document.head.appendChild(style);

  it("a lone `-` setext title renders at BODY size (heading em defeated)", () => {
    const view = mount("Foo\n-");
    expect(titleFontPx(view, "Foo")).toBe(BODY_PX);
    view.destroy();
  });

  it("a lone `=` setext title renders at BODY size", () => {
    const view = mount("Foo\n=");
    expect(titleFontPx(view, "Foo")).toBe(BODY_PX);
    view.destroy();
  });

  it("a REAL `---` heading still renders LARGER than body (no regression)", () => {
    const view = mount("Foo\n---");
    expect(titleFontPx(view, "Foo")).toBeGreaterThan(BODY_PX);
    view.destroy();
  });

  it("a MULTI-char `--` underline still renders as a heading (larger than body)", () => {
    const view = mount("Foo\n--");
    expect(titleFontPx(view, "Foo")).toBeGreaterThan(BODY_PX);
    view.destroy();
  });
});
