// @vitest-environment node
import { describe, expect, it } from "vitest";
import { stickyTopHeight } from "../../src/webview/cm/sticky-heading/viewport-top.js";

describe("stickyTopHeight", () => {
  // scrolled down 100px, doc top now 100px above the scroller top (documentTop = -100)
  it("maps screen scroll to document height (scaleY=1, no bar)", () => {
    expect(stickyTopHeight(0, -100, 0, 1, 10000)).toBe(100);
  });

  it("adds the bar height so the boundary is the bar's BOTTOM edge", () => {
    expect(stickyTopHeight(0, -100, 24, 1, 10000)).toBe(124);
  });

  it("divides the screen delta by scaleY (CSS transform: scale)", () => {
    expect(stickyTopHeight(0, -100, 0, 2, 10000)).toBe(50);
  });

  it("clamps below zero to 0 (scrolled above the top / overscroll)", () => {
    expect(stickyTopHeight(0, 50, 0, 1, 10000)).toBe(0);
  });

  it("clamps to contentHeight at the bottom", () => {
    expect(stickyTopHeight(0, -999999, 0, 1, 10000)).toBe(10000);
  });
});
