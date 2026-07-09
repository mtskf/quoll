// @vitest-environment happy-dom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { quollMarkdownLanguage } from "../../src/webview/cm/markdown.js";
import {
  quollStickyHeading,
  stickyHeadingPlugin,
} from "../../src/webview/cm/sticky-heading/index.js";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
  document.body.textContent = "";
});

function mount(doc: string): { view: EditorView; host: HTMLElement } {
  const host = document.createElement("div");
  host.className = "quoll-editor";
  document.body.appendChild(host);
  view = new EditorView({
    parent: host,
    state: EditorState.create({ doc, extensions: [quollMarkdownLanguage(), quollStickyHeading()] }),
  });
  return { view, host };
}
function bar(host: HTMLElement): HTMLElement | null {
  return host.querySelector(".quoll-sticky-heading");
}
function barText(host: HTMLElement): string | undefined {
  return host.querySelector(".quoll-sticky-heading-inner")?.textContent ?? undefined;
}

describe("quollStickyHeading bar", () => {
  it("creates a hidden bar element on mount", () => {
    const { host } = mount("# Alpha\n\nbody\n");
    expect(bar(host)).not.toBeNull();
    expect(bar(host)?.hidden).toBe(true);
  });

  it("shows the enclosing section heading when driven past a heading line", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    v.plugin(stickyHeadingPlugin)?.applyTop(5);
    expect(bar(host)?.hidden).toBe(false);
    expect(barText(host)).toBe("Alpha");
  });

  it("hides the bar at the document top (no heading strictly above)", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n");
    v.plugin(stickyHeadingPlugin)?.applyTop(0);
    expect(bar(host)?.hidden).toBe(true);
  });

  it("swaps to the next heading as the top position crosses it", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n\n## Beta\n\nmore\n");
    const betaFrom = v.state.doc.line(5).from;
    v.plugin(stickyHeadingPlugin)?.applyTop(betaFrom + 1);
    expect(barText(host)).toBe("Beta");
  });

  it("refreshes its heading cache when a heading is added", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n");
    v.dispatch({ changes: { from: v.state.doc.length, insert: "\n## Added\n\ntail\n" } });
    const addedFrom = v.state.doc.line(5).from;
    v.plugin(stickyHeadingPlugin)?.applyTop(addedFrom + 1);
    expect(barText(host)).toBe("Added");
  });

  it("renders (untitled) for a bare-# empty-text heading", () => {
    const { view: v, host } = mount("# \n\nbody\n"); // "# " → ATX heading, empty text
    v.plugin(stickyHeadingPlugin)?.applyTop(v.state.doc.length);
    expect(bar(host)?.hidden).toBe(false);
    expect(barText(host)).toBe("(untitled)");
  });

  it("does NOT rewrite the bar when the active heading is unchanged (dedup no-op)", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n\ntail\n");
    const plugin = v.plugin(stickyHeadingPlugin);
    plugin?.applyTop(v.state.doc.length); // shows "Alpha"
    const inner = host.querySelector<HTMLElement>(".quoll-sticky-heading-inner");
    if (!inner) {
      throw new Error("inner missing");
    }
    // Count textContent writes; the renderedKey guard must skip the second apply.
    let writes = 0;
    const desc = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");
    if (!desc?.get || !desc.set) {
      throw new Error("no textContent descriptor");
    }
    const realGet = desc.get;
    const realSet = desc.set;
    Object.defineProperty(inner, "textContent", {
      configurable: true,
      get() {
        return realGet.call(this);
      },
      set(value) {
        writes++;
        realSet.call(this, value);
      },
    });
    plugin?.applyTop(v.state.doc.length); // same heading → early-return, no rewrite
    expect(writes).toBe(0);
  });

  it("re-renders when a heading's TEXT changes but its position does not (Codex #3)", () => {
    const { view: v, host } = mount("# Alpha\n\nbody\n\ntail\n");
    v.plugin(stickyHeadingPlugin)?.applyTop(v.state.doc.length);
    expect(barText(host)).toBe("Alpha");
    v.dispatch({ changes: { from: 2, to: 7, insert: "Renamed" } }); // "# Alpha" → "# Renamed"
    v.plugin(stickyHeadingPlugin)?.applyTop(v.state.doc.length);
    expect(barText(host)).toBe("Renamed");
  });

  it("removes ITS scroll listener on destroy (add/remove balance — non-vacuous)", () => {
    // CM's own DOMObserver also adds/removes a "scroll" listener on scrollDOM, so
    // a naive `removed > 0` would pass even if the plugin leaked (Fable N3). Track
    // (target, handler) tuples across the whole lifecycle and assert every "scroll"
    // handler added on the scroller was removed — a leak of the plugin's own
    // handler leaves an unmatched add and fails.
    const added: Array<{ t: EventTarget; h: unknown }> = [];
    const removed: Array<{ t: EventTarget; h: unknown }> = [];
    const protoAdd = Element.prototype.addEventListener;
    const protoRemove = Element.prototype.removeEventListener;
    Element.prototype.addEventListener = function (
      this: Element,
      ...args: Parameters<typeof protoAdd>
    ) {
      if (args[0] === "scroll") {
        added.push({ t: this, h: args[1] });
      }
      return protoAdd.apply(this, args);
    };
    Element.prototype.removeEventListener = function (
      this: Element,
      ...args: Parameters<typeof protoRemove>
    ) {
      if (args[0] === "scroll") {
        removed.push({ t: this, h: args[1] });
      }
      return protoRemove.apply(this, args);
    };
    try {
      const { view: v, host } = mount("# Alpha\n\nbody\n");
      const scroller = v.scrollDOM;
      v.destroy();
      view = null;
      const addedOnScroller = added.filter((a) => a.t === scroller);
      expect(addedOnScroller.length).toBeGreaterThan(0);
      for (const a of addedOnScroller) {
        expect(removed.some((r) => r.t === scroller && r.h === a.h)).toBe(true);
      }
      expect(host.querySelector(".quoll-sticky-heading")).toBeNull();
    } finally {
      Element.prototype.addEventListener = protoAdd;
      Element.prototype.removeEventListener = protoRemove;
    }
  });
});
