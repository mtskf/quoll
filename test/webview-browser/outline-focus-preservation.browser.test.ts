// Real-chromium focus gates for the outline tree — the DOM-focus behaviour
// happy-dom cannot observe (no real focus model: hiding / removing the focused
// element does not blur it to <body> there). Pins two focus-preservation
// contracts a keyboard user depends on:
//   1. collapsing an ANCESTOR of the focused row (pointer twistie) must move
//      focus to the collapsed ancestor (nearest surviving visible row), not
//      strand it on <body> when refreshVisibility hides the focused descendant;
//   2. a rebuild while a keyboard user is navigating (renderList tears down the
//      whole <ul> via textContent = "") must restore focus to the equivalent
//      surviving row, not drop it on <body>.
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import "../../src/webview/styles.css";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { outlinePlugin, quollOutline } from "../../src/webview/cm/outline/index.js";
import { quollTheme } from "../../src/webview/cm/theme.js";

// Nested three-level tree: Alpha (h1) ⊃ Beta (h2) ⊃ Gamma (h3). Alpha and Beta
// both have children, so both carry a collapsible twistie.
const NESTED = "# Alpha\n\nbody\n\n## Beta\n\nmore\n\n### Gamma\n\ntail\n";

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.getElementById("root")?.remove();
});

function mount(doc: string): { view: EditorView; host: HTMLElement } {
  const root = document.createElement("div");
  root.id = "root";
  const main = document.createElement("main");
  const host = document.createElement("div");
  host.className = "quoll-editor";
  main.appendChild(host);
  root.appendChild(main);
  document.body.appendChild(root);
  view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [quollTheme, quollMarkdownLanguage(), quollOutline()],
    }),
  });
  return { view, host };
}

function settled(): Promise<void> {
  return new Promise((resolve) => {
    let n = 4;
    const tick = () => (--n <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
}

/** The tree row <li> whose heading label matches `text`. */
function rowByText(host: HTMLElement, text: string): HTMLLIElement {
  const items = [...host.querySelectorAll<HTMLElement>(".quoll-outline-item")];
  const label = items.find((el) => el.textContent === text);
  if (!label) {
    throw new Error(`no outline row labelled "${text}"`);
  }
  return label.closest<HTMLLIElement>(".quoll-outline-row") as HTMLLIElement;
}

describe("outline tree — keyboard focus preservation", () => {
  it("collapsing an ancestor of the focused row re-homes focus to the ancestor (not <body>)", async () => {
    const { view: v, host } = mount(NESTED);
    v.plugin(outlinePlugin)?.toggle(); // deliberate open (forces a complete parse)
    await settled();

    const gamma = rowByText(host, "Gamma");
    gamma.focus();
    expect(document.activeElement).toBe(gamma);

    // Collapse Alpha (the grandparent) via its decorative twistie — a pointer
    // affordance. refreshVisibility hides Beta AND Gamma; the browser blurs the
    // now-hidden focused Gamma to <body> unless focus is re-homed.
    const alpha = rowByText(host, "Alpha");
    const twistie = alpha.querySelector(".quoll-outline-twistie") as HTMLElement;
    twistie.click();
    await settled();

    expect(gamma.hidden).toBe(true); // the focused row really did get hidden
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(alpha); // nearest surviving visible row
  });

  it("a rebuild during keyboard navigation restores focus to the equivalent row", async () => {
    const { view: v, host } = mount(NESTED);
    v.plugin(outlinePlugin)?.toggle();
    await settled();

    const beta = rowByText(host, "Beta");
    beta.focus();
    expect(document.activeElement).toBe(beta);

    // Append a new heading at the very end: the outline signature changes, so the
    // debounced rebuild tears down and re-renders the whole <ul> (textContent =
    // "" drops the focused row to <body>). Beta's `from` is unchanged, so focus
    // must land back on the equivalent (new) Beta row.
    v.dispatch({
      changes: { from: v.state.doc.length, insert: "\n## Delta\n\nx\n" },
      selection: EditorSelection.cursor(v.state.doc.length),
    });
    // Wait out the 200ms REBUILD_DEBOUNCE_MS, then let layout settle.
    await new Promise((r) => setTimeout(r, 300));
    await settled();

    // The list really was rebuilt (new heading present) and Beta is a fresh node.
    const betaAfter = rowByText(host, "Beta");
    expect(rowByText(host, "Delta")).toBeTruthy();
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(betaAfter);
  });
});
