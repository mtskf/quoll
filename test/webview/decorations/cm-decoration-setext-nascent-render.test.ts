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
import { quollSyntaxReveal } from "../../../src/webview/cm/decorations/index.js";
import { quollMarkdownLanguage } from "../../../src/webview/cm/markdown.js";
import { quollHighlighting, quollTokenMarkers } from "../../../src/webview/cm/theme.js";

vi.mock("../../../src/webview/host.js", () => ({
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
      extensions: [
        quollMarkdownLanguage(),
        quollHighlighting,
        quollTokenMarkers,
        quollSyntaxReveal(),
      ],
    }),
  });
}

/** The deepest span carrying the given text on the first `.cm-line` — i.e. the
 *  element whose computed style is what the reader actually sees for that run. */
function deepestSpan(view: EditorView, text: string): Element | null {
  const line = view.contentDOM.querySelector(".cm-line");
  const spans = [...(line?.querySelectorAll("span") ?? [])];
  return spans.reverse().find((s) => s.textContent?.includes(text)) ?? line;
}

/** Computed font-size (px) of the deepest span carrying `text` on the first line. */
function titleFontPx(view: EditorView, text: string): number {
  const target = deepestSpan(view, text);
  const fs = target ? getComputedStyle(target).fontSize : "";
  return Number.parseFloat(fs);
}

describe("nascent-setext de-style — computed size against the real highlight", () => {
  // Inject the real webview stylesheet + a definite body font-size token so the
  // heading `em` and the reset both resolve to comparable px.
  const style = document.createElement("style");
  // cwd is the repo root under vitest; happy-dom's import.meta.url is an http
  // URL, so resolve from cwd instead of import.meta.url.
  const cssPath = resolve(process.cwd(), "src/webview/styles.css");
  // Definite body size + DISTINCT weight/colour tokens so the reset target and
  // the preserved token values are unambiguously different in computed style:
  // the reset paints --vscode-editor-foreground (FG) + weight 400; the link
  // keep-rule paints --quoll-accent-green (GREEN); strong keeps weight 700.
  const FG = "rgb(10, 10, 10)";
  const GREEN = "rgb(0, 128, 0)";
  style.textContent = `${readFileSync(cssPath, "utf8")}\n:root{--vscode-font-size:${BODY_PX}px;--vscode-editor-foreground:${FG};--quoll-accent-green:${GREEN}}`;
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

  // The inline-emphasis survival contract (the PR's point): the heading LOOK is
  // demoted (body size) while bold/link styling of the paragraph is PRESERVED.
  // These red before the keep-rules exist (the reset flattens weight→400 and
  // colour→FG on the combined heading+token span).
  it("bold inside a nascent-setext keeps its weight while the line drops to body size", () => {
    const view = mount("Foo **bar**\n-");
    expect(titleFontPx(view, "Foo")).toBe(BODY_PX); // heading look still demoted
    const bar = deepestSpan(view, "bar");
    expect(bar && getComputedStyle(bar).fontWeight).toBe("700"); // bold survives
    // Pin that the strong keep-rule stays scoped to weight — it must not also
    // re-inflate font-size, which would undo the heading→body demotion above.
    expect(bar && getComputedStyle(bar).fontSize).toBe(`${BODY_PX}px`);
    view.destroy();
  });

  it("bold at the heading's FIRST byte keeps its weight (leading-emphasis edge)", () => {
    // Strong starts at offset 0 — nesting here is guaranteed by precedence RANK,
    // not range containment, so this case detects a future CM precedence change
    // the mid-string case would not.
    const view = mount("**Foo** bar\n-");
    const foo = deepestSpan(view, "Foo");
    expect(foo && getComputedStyle(foo).fontWeight).toBe("700");
    view.destroy();
  });

  it("a link inside a nascent-setext carries the keep-rule marker class", () => {
    // The link colour keep-rule uses a NESTED-var value
    // (`var(--quoll-accent-green, var(--vscode-textLink-foreground))`) that happy-dom
    // drops on SYNTAX (a probe that defines --quoll-accent-green still computes
    // empty), so the reset FG wins here and the green is UNPROVABLE in happy-dom.
    // The bold case above proves the shared specificity/nesting mechanism
    // behaviourally; for the link this pins the marker span the keep-rule binds to
    // (non-vacuous: absent until quollTokenMarkers is mounted), the keep-rule's
    // green is pinned by styles-contract.test.ts, and the rendered colour by the
    // real-browser harness (pnpm preview).
    const view = mount("[x](u)\n-");
    const link = deepestSpan(view, "x");
    expect(link?.classList.contains("quoll-tok-link")).toBe(true);
    // Pin that the link keep-rule stays scoped to colour — font-size is a plain
    // cascade value happy-dom DOES resolve, unlike the nested-var colour above.
    expect(link && getComputedStyle(link).fontSize).toBe(`${BODY_PX}px`);
    view.destroy();
  });
});
