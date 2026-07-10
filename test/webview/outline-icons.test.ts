// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createPinIcon, createSettingsIcon } from "../../src/webview/cm/outline/icons.js";

const SVG_NS = "http://www.w3.org/2000/svg";

describe("outline sidebar icons", () => {
  it("builds the Lucide pin as a stroke-styled SVG subtree (no innerHTML)", () => {
    const svg = createPinIcon();
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("fill")).toBe("none");
    expect(svg.getAttribute("stroke")).toBe("currentColor"); // tracks button color → red when .pinned
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelectorAll("path")).toHaveLength(2); // stem + body
  });

  it("builds the Lucide settings gear (outer path + centre circle)", () => {
    const svg = createSettingsIcon();
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.querySelectorAll("path")).toHaveLength(1);
    expect(svg.querySelectorAll("circle")).toHaveLength(1);
  });

  it("returns a fresh subtree per call (safe to mount in several buttons)", () => {
    expect(createPinIcon()).not.toBe(createPinIcon());
  });
});
