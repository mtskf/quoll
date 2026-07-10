// @vitest-environment happy-dom
// test/webview/reading-stats-plugin.test.ts
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import { quollReadingStats } from "../../src/webview/cm/reading-stats/index.js";

let view: EditorView | null = null;

function mount(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  host.className = "quoll-editor";
  document.body.appendChild(host);
  const v = new EditorView({
    parent: host,
    state: EditorState.create({
      doc,
      extensions: [quollMarkdownLanguage(), quollReadingStats()],
    }),
  });
  view = v;
  return { view: v, host };
}

afterEach(() => {
  view?.destroy();
  view = null;
  document.querySelectorAll(".quoll-editor").forEach((n) => {
    n.remove();
  });
  vi.useRealTimers();
});

describe("quollReadingStats ViewPlugin", () => {
  it("renders an initial readout into the editor host", () => {
    const { host } = mount("# Title\n\nHello world of prose.");
    const el = host.querySelector(".quoll-reading-stats");
    expect(el).not.toBeNull();
    // compute.ts strips frontmatter/fenced-code only, not ATX `#` markers, so
    // the heading marker itself is a whitespace-delimited token: "#", "Title",
    // "Hello", "world", "of", "prose." = 6 words.
    expect(el?.textContent).toContain("6 words");
    expect(el?.textContent).toContain("min read");
  });

  it("puts heading/link counts in the title tooltip", () => {
    const { host } = mount("# A\n\n## B\n\nSee [x](https://e.example).");
    const el = host.querySelector<HTMLElement>(".quoll-reading-stats");
    expect(el?.title).toContain("2 headings");
    expect(el?.title).toContain("1 link");
  });

  it("recomputes after a debounced doc change", () => {
    vi.useFakeTimers();
    const { view, host } = mount("one two");
    const el = host.querySelector<HTMLElement>(".quoll-reading-stats");
    expect(el?.textContent).toContain("2 words");
    view.dispatch({ changes: { from: view.state.doc.length, insert: " three four" } });
    // Not updated synchronously (debounced, off the keystroke path).
    expect(el?.textContent).toContain("2 words");
    vi.advanceTimersByTime(300);
    expect(el?.textContent).toContain("4 words");
  });

  it("refreshes on a full-document reseed (host snapshot) like any edit", () => {
    vi.useFakeTimers();
    const { view, host } = mount("one two three");
    const el = host.querySelector<HTMLElement>(".quoll-reading-stats");
    expect(el?.textContent).toContain("3 words");
    // Simulate editor.ts#applyDocument's wholesale replace (host reseed).
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "alpha beta" } });
    vi.advanceTimersByTime(300);
    expect(el?.textContent).toContain("2 words");
  });

  it("removes its node on destroy", () => {
    const { host } = mount("hi there");
    expect(host.querySelector(".quoll-reading-stats")).not.toBeNull();
    view?.destroy();
    view = null;
    expect(host.querySelector(".quoll-reading-stats")).toBeNull();
  });
});
