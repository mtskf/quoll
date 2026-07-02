// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { outlinePlugin, quollOutline } from "../../src/webview/cm/outline/index.js";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
  document.body.textContent = "";
  vi.useRealTimers();
});

function mount(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  host.className = "quoll-editor";
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [quollMarkdownLanguage(), quollOutline()] }),
  });
  return { view, host };
}

function itemTexts(host: HTMLElement): string[] {
  return [...host.querySelectorAll(".quoll-outline-item")].map((el) => el.textContent ?? "");
}

describe("quollOutline panel", () => {
  it("does not build the list until the panel is opened", () => {
    const { host } = mount("# Alpha\n");
    expect(host.querySelectorAll(".quoll-outline-item")).toHaveLength(0);
  });

  it("lists headings in document order when opened", () => {
    const { view: v, host } = mount("# Alpha\n\n## Beta\n\n## Gamma\n");
    v.plugin(outlinePlugin)?.toggle();
    expect(itemTexts(host)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("moves the selection to the heading line on click (selection-only, byte-preserving)", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const before = v.state.doc.toString();
    v.plugin(outlinePlugin)?.toggle();
    const items = host.querySelectorAll<HTMLButtonElement>(".quoll-outline-item");
    items[1].click(); // "Beta"
    const betaLine = v.state.doc.line(5); // "## Beta"
    expect(v.state.selection.main.head).toBe(betaLine.from);
    expect(v.state.selection.main.empty).toBe(true);
    expect(v.state.doc.toString()).toBe(before);
  });

  it("refreshes the list when the document changes while open (debounced)", () => {
    vi.useFakeTimers();
    const { view: v, host } = mount("# Alpha\n");
    v.plugin(outlinePlugin)?.toggle(); // immediate rebuild on open
    expect(itemTexts(host)).toEqual(["Alpha"]);
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Alpha\n\n## Added\n" } });
    vi.advanceTimersByTime(250); // let the debounced rebuild fire
    expect(itemTexts(host)).toEqual(["Alpha", "Added"]);
  });

  it("shows an empty state when opened on a document with no headings", () => {
    const { view: v, host } = mount("no headings here\n");
    v.plugin(outlinePlugin)?.toggle();
    expect(host.querySelector(".quoll-outline-empty")?.textContent).toBe("No headings");
    expect(itemTexts(host)).toEqual([]);
  });

  it("cancels the pending debounced rebuild when the panel is closed", () => {
    // Fake ONLY setTimeout/clearTimeout so getTimerCount reflects the plugin's
    // debounce alone (verified: a tiny-doc view/parser schedules no setTimeout —
    // probe: mount=0, dispatch=0, schedule=1, clear=0).
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view: v } = mount("# Alpha\n");
    const plugin = v.plugin(outlinePlugin);
    plugin?.toggle(); // open (synchronous rebuild — no timer)
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Alpha\n\n## Added\n" } });
    expect(vi.getTimerCount()).toBe(1); // the edit scheduled the debounce
    plugin?.toggle(); // close → setOpen(false) must clear the timer
    expect(vi.getTimerCount()).toBe(0); // pinned: FAILS if the clearTimeout is removed
  });

  it("cancels the pending debounced rebuild on destroy", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { view: v } = mount("# Alpha\n");
    v.plugin(outlinePlugin)?.toggle();
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "# Alpha\n\n## Added\n" } });
    expect(vi.getTimerCount()).toBe(1);
    v.destroy(); // must clearTimeout(this.rebuildTimer)
    view = null;
    expect(vi.getTimerCount()).toBe(0); // pinned: FAILS if the clearTimeout is removed
  });

  it("removes its DOM on destroy", () => {
    const { view: v, host } = mount("# Alpha\n");
    v.plugin(outlinePlugin)?.toggle();
    v.destroy();
    view = null;
    expect(host.querySelector(".quoll-outline-toggle")).toBeNull();
    expect(host.querySelector(".quoll-outline-panel")).toBeNull();
  });
});
