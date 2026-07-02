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
