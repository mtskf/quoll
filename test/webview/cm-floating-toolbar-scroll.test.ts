// @vitest-environment happy-dom
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import {
  CHROME_HIDDEN_CLASS,
  nextToolbarScrollState,
  quollFloatingToolbarScroll,
  type ToolbarScrollState,
} from "../../src/webview/cm/floating-toolbar-scroll.js";

describe("nextToolbarScrollState — direction→visibility mapping", () => {
  it("hides on scroll DOWN past the hysteresis dead-zone (re-anchors)", () => {
    expect(nextToolbarScrollState({ visibility: "shown", anchor: 100 }, 200)).toEqual({
      visibility: "hidden",
      anchor: 200,
    });
  });

  it("shows on scroll UP past the dead-zone (re-anchors)", () => {
    expect(nextToolbarScrollState({ visibility: "hidden", anchor: 200 }, 100)).toEqual({
      visibility: "shown",
      anchor: 100,
    });
  });

  it("ALWAYS shows near the very top and re-anchors there, whatever the prior state", () => {
    expect(nextToolbarScrollState({ visibility: "hidden", anchor: 300 }, 0)).toEqual({
      visibility: "shown",
      anchor: 0,
    });
    expect(nextToolbarScrollState({ visibility: "hidden", anchor: 300 }, 5)).toEqual({
      visibility: "shown",
      anchor: 5,
    });
  });

  it("holds state AND anchor inside the dead-zone (jitter immunity)", () => {
    const prev: ToolbarScrollState = { visibility: "shown", anchor: 100 };
    expect(nextToolbarScrollState(prev, 102)).toEqual(prev); // +2px < 4px hysteresis
    expect(nextToolbarScrollState(prev, 98)).toEqual(prev); // -2px
  });

  it("accumulates slow drift because the anchor is NOT reset in the dead-zone", () => {
    // Two sub-threshold ticks that together exceed the hysteresis must still flip.
    const prev: ToolbarScrollState = { visibility: "shown", anchor: 100 };
    const afterFirst = nextToolbarScrollState(prev, 103); // +3px < 4px → held, anchor stays 100
    expect(afterFirst).toEqual(prev);
    const afterSecond = nextToolbarScrollState(afterFirst, 106); // 106-100 = 6px > 4px → flip
    expect(afterSecond).toEqual({ visibility: "hidden", anchor: 106 });
  });

  it("honours custom thresholds", () => {
    expect(
      nextToolbarScrollState({ visibility: "shown", anchor: 100 }, 300, { hysteresis: 50 }).visibility
    ).toBe("hidden");
    expect(
      nextToolbarScrollState({ visibility: "shown", anchor: 100 }, 130, { hysteresis: 50 }).visibility
    ).toBe("shown"); // 30px < 50px → held (still shown)
    expect(
      nextToolbarScrollState({ visibility: "hidden", anchor: 0 }, 40, { topThreshold: 50 }).visibility
    ).toBe("shown"); // within the widened top band
  });

  it("exports the shared host class name", () => {
    expect(CHROME_HIDDEN_CLASS).toBe("quoll-chrome-hidden");
  });
});

describe("quollFloatingToolbarScroll — ViewPlugin (happy-dom)", () => {
  let view: EditorView | null = null;

  afterEach(() => {
    view?.destroy();
    view = null;
    document.body.textContent = "";
  });

  function mount(extensions: Extension[]): HTMLElement {
    const host = document.createElement("div");
    host.className = "quoll-editor";
    document.body.appendChild(host);
    view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: "x\n".repeat(200), extensions }),
    });
    return host;
  }

  function scrollTo(scrollTop: number): void {
    const scroller = (view as EditorView).scrollDOM;
    scroller.scrollTop = scrollTop;
    scroller.dispatchEvent(new Event("scroll"));
  }

  it("stamps quoll-chrome-hidden on the host on scroll DOWN, clears it on scroll UP", () => {
    const host = mount([quollFloatingToolbarScroll()]);
    expect(host.classList.contains(CHROME_HIDDEN_CLASS)).toBe(false);
    scrollTo(300); // down
    expect(host.classList.contains(CHROME_HIDDEN_CLASS)).toBe(true);
    scrollTo(100); // up
    expect(host.classList.contains(CHROME_HIDDEN_CLASS)).toBe(false);
  });

  it("always clears the class near the top even after a hide", () => {
    const host = mount([quollFloatingToolbarScroll()]);
    scrollTo(300);
    expect(host.classList.contains(CHROME_HIDDEN_CLASS)).toBe(true);
    scrollTo(0); // back to the very top
    expect(host.classList.contains(CHROME_HIDDEN_CLASS)).toBe(false);
  });

  it("removes the class on destroy (no leaked hidden state)", () => {
    const host = mount([quollFloatingToolbarScroll()]);
    scrollTo(300);
    expect(host.classList.contains(CHROME_HIDDEN_CLASS)).toBe(true);
    view?.destroy();
    view = null;
    expect(host.classList.contains(CHROME_HIDDEN_CLASS)).toBe(false);
  });
});
