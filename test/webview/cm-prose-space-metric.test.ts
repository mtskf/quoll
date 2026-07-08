// @vitest-environment happy-dom
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  nextProseSpacePublish,
  proseSpaceMetric,
} from "../../src/webview/cm/decorations/prose-space-metric.js";

describe("nextProseSpacePublish — publish policy (layout-free, non-vacuous)", () => {
  it("publishes a positive measurement as `Npx` when none was published", () => {
    expect(nextProseSpacePublish(4.45, null)).toEqual({ action: "set", value: "4.45px" });
  });
  it("no-ops when the measurement is unchanged", () => {
    expect(nextProseSpacePublish(4.45, "4.45px")).toEqual({ action: "none" });
  });
  it("re-publishes when the measurement changes (font / zoom change)", () => {
    expect(nextProseSpacePublish(6, "4.45px")).toEqual({ action: "set", value: "6px" });
  });
  it("retracts a stale value when a later measurement is non-positive (detached)", () => {
    expect(nextProseSpacePublish(0, "4.45px")).toEqual({ action: "remove" });
  });
  it("no-ops on a non-positive measurement when nothing was published", () => {
    expect(nextProseSpacePublish(0, null)).toEqual({ action: "none" });
    expect(nextProseSpacePublish(-3, null)).toEqual({ action: "none" });
  });
  it("treats non-finite widths (Infinity / NaN) as unusable — never a garbage `Infinitypx`", () => {
    expect(nextProseSpacePublish(Number.POSITIVE_INFINITY, null)).toEqual({ action: "none" });
    expect(nextProseSpacePublish(Number.POSITIVE_INFINITY, "4.45px")).toEqual({ action: "remove" });
    expect(nextProseSpacePublish(Number.NaN, null)).toEqual({ action: "none" });
  });
});

// CM's synchronous measure flush exists at runtime but is not in the public
// type surface; cast to invoke it deterministically instead of awaiting a frame.
function flushMeasure(view: EditorView): void {
  (view as unknown as { measure(): void }).measure();
}

function mount(doc: string): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage }), proseSpaceMetric],
    }),
    parent,
  });
}

describe("proseSpaceMetric — lifecycle", () => {
  it("appends exactly one hidden probe on mount and removes it (+ the var) on destroy", () => {
    const view = mount("- alpha\n  - beta");
    const host = view.dom;
    expect(host.querySelectorAll(".quoll-prose-probe").length).toBe(1);
    // happy-dom has no layout → measured width 0 → the policy publishes nothing,
    // so the stylesheet `1ch` fallback governs (no bogus `0px`).
    expect(host.style.getPropertyValue("--quoll-prose-space")).toBe("");
    view.destroy();
    expect(host.querySelectorAll(".quoll-prose-probe").length).toBe(0);
    expect(host.style.getPropertyValue("--quoll-prose-space")).toBe("");
  });
});

describe("proseSpaceMetric — live prose-font change (ResizeObserver re-measure)", () => {
  // happy-dom has no layout engine, so real ResizeObserver callbacks never fire.
  // Stub RO to capture the plugin's callback + observed target, then drive a
  // font swap by changing the probe's reported width and firing the callback.
  // This pins the follow-up-TODO fix: a font change that leaves line-height
  // unchanged (so CM never raises geometryChanged) still re-aligns without a
  // reload. Reverting the RO wiring makes this test red (no re-publish to 8px).
  it("re-measures when a font swap changes the probe's space advance", () => {
    // CM's EditorView also constructs a ResizeObserver on the global, so track
    // observers per-instance and fire only the one that observed the probe.
    const observers: { cb: ResizeObserverCallback; targets: Element[] }[] = [];
    const realResizeObserver = globalThis.ResizeObserver;
    class StubResizeObserver {
      private readonly entry: { cb: ResizeObserverCallback; targets: Element[] };
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, targets: [] };
        observers.push(this.entry);
      }
      observe(el: Element): void {
        this.entry.targets.push(el);
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    // biome-ignore lint/suspicious/noExplicitAny: minimal RO stub for the test
    globalThis.ResizeObserver = StubResizeObserver as any;

    let spacePx = 5; // rendered advance of ONE space, in CSS px
    try {
      const view = mount("- alpha\n  - beta");
      const host = view.dom;
      const probe = host.querySelector<HTMLSpanElement>(".quoll-prose-probe");
      expect(probe).not.toBeNull();

      // The plugin MUST observe its own probe box — find that observer.
      const probeObserver = observers.find((o) => o.targets.includes(probe as Element));
      expect(probeObserver).toBeDefined();

      // Simulate a real layout: the probe holds PROBE_SPACES (20) spaces, each
      // `spacePx` wide. (getBoundingClientRect returns 0 under happy-dom.)
      (probe as HTMLSpanElement).getBoundingClientRect = (() =>
        ({ width: spacePx * 20 }) as DOMRect) as HTMLSpanElement["getBoundingClientRect"];

      // Flush the mount measure → first publish at the current font.
      flushMeasure(view);
      expect(host.style.getPropertyValue("--quoll-prose-space")).toBe("5px");

      // Live font swap: the space now renders wider. A bare re-flush must NOT
      // re-publish on its own — the keyed measure already ran and CM raises no
      // geometryChanged for a line-height-preserving font change.
      spacePx = 8;
      flushMeasure(view);
      expect(host.style.getPropertyValue("--quoll-prose-space")).toBe("5px");

      // The probe ResizeObserver firing is the ONLY thing that re-measures here.
      probeObserver?.cb([], {} as ResizeObserver);
      flushMeasure(view);
      expect(host.style.getPropertyValue("--quoll-prose-space")).toBe("8px");

      view.destroy();
    } finally {
      globalThis.ResizeObserver = realResizeObserver;
    }
  });
});
