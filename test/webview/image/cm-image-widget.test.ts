// @vitest-environment happy-dom
import { type EditorView, WidgetType } from "@codemirror/view";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AllowlistedUrl } from "../../../src/markdown/url-allowlist.js";
import { imageDimensionCache } from "../../../src/webview/cm/image/image-dimension-cache.js";
import { ImageBlockWidget } from "../../../src/webview/cm/image/image-widget.js";

// The widget's safeUrl param is branded AllowlistedUrl; tests legitimately
// bypass the brand (the field is the only production constructor and passes a
// gated value). One local cast helper keeps the call sites readable.
const url = (s: string): AllowlistedUrl => s as AllowlistedUrl;

const mockView = { dispatch: () => {} } as unknown as EditorView;

// View stub that records every dispatched selection, for the click tests that
// assert WHICH caret offset the widget aimed at.
const recordingView = (
  base: number
): { view: EditorView; dispatched: Array<{ anchor: number }> } => {
  const dispatched: Array<{ anchor: number }> = [];
  const view = {
    contentDOM: document.createElement("div"),
    posAtDOM: () => base,
    dispatch: (tr: { selection?: { anchor: number } }) => {
      if (tr.selection) {
        dispatched.push(tr.selection);
      }
    },
  } as unknown as EditorView;
  return { view, dispatched };
};

describe("ImageBlockWidget.toDOM (allowlisted)", () => {
  it("renders <div class='quoll-block quoll-image-block'> wrapping a live <img>", () => {
    const dom = new ImageBlockWidget(
      "logo",
      url("https://x.test/a.png"),
      "![logo](https://x.test/a.png)"
    ).toDOM(mockView);
    expect(dom.tagName).toBe("DIV");
    expect(dom.classList.contains("quoll-block")).toBe(true);
    expect(dom.classList.contains("quoll-image-block")).toBe(true);
    const img = dom.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe("https://x.test/a.png");
  });

  it("reaches the alt text to the <img>", () => {
    const dom = new ImageBlockWidget(
      "my alt",
      url("https://x.test/a.png"),
      "![my alt](https://x.test/a.png)"
    ).toDOM(mockView);
    expect(dom.querySelector("img")?.alt).toBe("my alt");
  });

  it("preserves an empty alt (![](url)) as an empty <img alt>", () => {
    const dom = new ImageBlockWidget(
      "",
      url("https://x.test/a.png"),
      "![](https://x.test/a.png)"
    ).toDOM(mockView);
    const img = dom.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.alt).toBe("");
  });

  it("creates NO <a> element (the click handler assumes no anchor exists)", () => {
    const dom = new ImageBlockWidget(
      "a",
      url("https://x.test/a.png"),
      "![a](https://x.test/a.png)"
    ).toDOM(mockView);
    expect(dom.querySelector("a")).toBeNull();
  });
});

describe("ImageBlockWidget.toDOM (blocked)", () => {
  it("renders an inert placeholder with NO <img> and NO src for a blocked url", () => {
    const dom = new ImageBlockWidget("x", null, "![x](javascript:alert(1))").toDOM(mockView);
    expect(dom.querySelector("img")).toBeNull();
    expect(dom.querySelector("[src]")).toBeNull(); // no element anywhere carries src → no request
    expect(dom.querySelector("a")).toBeNull();
    expect(dom.outerHTML.includes("javascript:")).toBe(false);
  });

  it("gives the blocked placeholder an accessible label (role=img + aria-label)", () => {
    const dom = new ImageBlockWidget("diagram", null, "![diagram](data:text/html,x)").toDOM(
      mockView
    );
    const ph = dom.querySelector(".quoll-image-blocked");
    expect(ph).not.toBeNull();
    expect(ph?.getAttribute("role")).toBe("img");
    expect(ph?.getAttribute("aria-label")).toBe("Blocked image: diagram");
  });

  it("labels a blocked image with empty alt generically", () => {
    const dom = new ImageBlockWidget("", null, "![](//evil.test/x.png)").toDOM(mockView);
    expect(dom.querySelector(".quoll-image-blocked")?.getAttribute("aria-label")).toBe(
      "Blocked image"
    );
  });
});

describe("ImageBlockWidget identity + events", () => {
  it("eq() is true for the same slice", () => {
    const a = new ImageBlockWidget("a", url("https://x.test/a.png"), "![a](https://x.test/a.png)");
    const b = new ImageBlockWidget("a", url("https://x.test/a.png"), "![a](https://x.test/a.png)");
    expect(a.eq(b)).toBe(true);
  });

  it("eq() is false when slice differs", () => {
    const a = new ImageBlockWidget("a", url("https://x.test/a.png"), "![a](https://x.test/a.png)");
    const b = new ImageBlockWidget("a", url("https://x.test/b.png"), "![a](https://x.test/b.png)");
    expect(a.eq(b)).toBe(false);
  });

  it("eq() is false against a different WidgetType subclass", () => {
    class Other extends WidgetType {
      toDOM(): HTMLElement {
        return document.createElement("div");
      }
    }
    const a = new ImageBlockWidget("a", url("https://x.test/a.png"), "![a](https://x.test/a.png)");
    expect(a.eq(new Other())).toBe(false);
  });

  it("ignoreEvent() returns true (atomic widget)", () => {
    expect(
      new ImageBlockWidget(
        "a",
        url("https://x.test/a.png"),
        "![a](https://x.test/a.png)"
      ).ignoreEvent()
    ).toBe(true);
  });

  it("click on the widget dispatches a selection to the current block start (reveal trigger)", () => {
    const { view, dispatched } = recordingView(42);
    const dom = new ImageBlockWidget(
      "a",
      url("https://x.test/a.png"),
      "![a](https://x.test/a.png)"
    ).toDOM(view);
    view.contentDOM.appendChild(dom);
    dom.click();
    expect(dispatched).toEqual([{ anchor: 42 }]);
  });

  it("click on the blocked placeholder also dispatches caret to the current block start", () => {
    const { view, dispatched } = recordingView(5);
    const dom = new ImageBlockWidget("a", null, "![a](javascript:alert(1))").toDOM(view);
    view.contentDOM.appendChild(dom);
    dom.click();
    expect(dispatched).toEqual([{ anchor: 5 }]);
  });

  it("a foreign image root dispatches nothing", () => {
    const { view, dispatched } = recordingView(7);
    const dom = new ImageBlockWidget("a", null, "![a](javascript:alert(1))").toDOM(view);
    document.body.appendChild(dom);
    try {
      dom.click();
      expect(dispatched).toEqual([]);
    } finally {
      dom.remove();
    }
  });

  it("logs and swallows a throwing dispatch instead of letting it escape the listener", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const boom = new RangeError("Selection points outside of document");
      const stub = {
        contentDOM: document.createElement("div"),
        posAtDOM: () => 7,
        dispatch: () => {
          throw boom;
        },
      } as unknown as EditorView;
      const dom = new ImageBlockWidget(
        "a",
        url("https://x.test/a.png"),
        "![a](https://x.test/a.png)"
      ).toDOM(stub);
      stub.contentDOM.appendChild(dom);
      dom.click();
      expect(errSpy).toHaveBeenCalledWith("[quoll] image widget selection dispatch failed", {
        anchor: 7,
        err: boom,
      });
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe("ImageBlockWidget.toDOM — dimension cache", () => {
  beforeEach(() => {
    imageDimensionCache.clear();
  });

  it("reserves space from a cached entry (sets width/height attrs before load)", () => {
    imageDimensionCache.set("https://x.test/cached.png", { width: 640, height: 480 });
    const dom = new ImageBlockWidget(
      "c",
      url("https://x.test/cached.png"),
      "![c](https://x.test/cached.png)"
    ).toDOM(mockView);
    const img = dom.querySelector("img");
    expect(img?.getAttribute("width")).toBe("640");
    expect(img?.getAttribute("height")).toBe("480");
  });

  it("does not set width/height when nothing is cached", () => {
    const dom = new ImageBlockWidget(
      "u",
      url("https://x.test/uncached.png"),
      "![u](https://x.test/uncached.png)"
    ).toDOM(mockView);
    const img = dom.querySelector("img");
    expect(img?.hasAttribute("width")).toBe(false);
    expect(img?.hasAttribute("height")).toBe(false);
  });

  it("populates the cache from naturalWidth/Height on the img load event", () => {
    const key = "https://x.test/load.png";
    const dom = new ImageBlockWidget("l", url(key), `![l](${key})`).toDOM(mockView);
    const img = dom.querySelector("img");
    expect(img).not.toBeNull();
    // happy-dom does not lay out images, so stub the natural dimensions.
    Object.defineProperty(img, "naturalWidth", { value: 800, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 600, configurable: true });
    img?.dispatchEvent(new Event("load"));
    expect(imageDimensionCache.get(key)).toEqual({ width: 800, height: 600 });
  });

  it("does not cache a zero-dimension (failed) load", () => {
    const key = "https://x.test/broken.png";
    const dom = new ImageBlockWidget("b", url(key), `![b](${key})`).toDOM(mockView);
    const img = dom.querySelector("img");
    Object.defineProperty(img, "naturalWidth", { value: 0, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 0, configurable: true });
    img?.dispatchEvent(new Event("load"));
    expect(imageDimensionCache.get(key)).toBeUndefined();
  });
});

describe("ImageBlockWidget.updateDOM", () => {
  it("returns false when the slice changes", () => {
    const first = new ImageBlockWidget(
      "a",
      url("https://x.test/a.png"),
      "![a](https://x.test/a.png)"
    );
    const next = new ImageBlockWidget(
      "b",
      url("https://x.test/b.png"),
      "![b](https://x.test/b.png)"
    );
    const root = first.toDOM(mockView);
    expect(next.updateDOM(root, mockView, first)).toBe(false);
    expect(root.querySelector("img")?.alt).toBe("a");
  });
});

describe("ImageBlockWidget.toDOM — load-error breadcrumb", () => {
  // The error latch is module-level (once per webview session). This is the
  // ONLY test in the suite that dispatches an "error" event on a widget <img>,
  // so the latch is fresh here; assert on the FIRST error dispatch.
  it("logs one console.warn breadcrumb with the src when the <img> fails to load", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const key = "https://x.test/err.png";
      const dom = new ImageBlockWidget("e", url(key), `![e](${key})`).toDOM(mockView);
      const img = dom.querySelector("img");
      expect(img).not.toBeNull();
      img?.dispatchEvent(new Event("error"));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith("[quoll] image failed to load", { src: key });
    } finally {
      warnSpy.mockRestore();
    }
  });
});
