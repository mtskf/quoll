// @vitest-environment node
import { describe, expect, it } from "vitest";
import { stickyTopHeight } from "../../src/webview/cm/sticky-heading/viewport-top.js";

describe("stickyTopHeight", () => {
  // scrolled down 100px: documentTop is now 100px above the scroller top
  it("maps the screen scroll delta to a document height (no bar)", () => {
    expect(
      stickyTopHeight({ scrollerTop: 0, documentTop: -100, barHeight: 0, contentHeight: 10000 })
    ).toBe(100);
  });

  it("adds the bar height so the boundary is the bar's BOTTOM edge", () => {
    expect(
      stickyTopHeight({ scrollerTop: 0, documentTop: -100, barHeight: 24, contentHeight: 10000 })
    ).toBe(124);
  });

  // CM's block height map is screen-space, so the height is the RAW screen delta
  // (no scale division) — pin that it is a straight subtraction, not `/scaleY`.
  it("is the undivided screen delta (height map is screen-space)", () => {
    expect(
      stickyTopHeight({ scrollerTop: 40, documentTop: -160, barHeight: 16, contentHeight: 10000 })
    ).toBe(216);
  });

  it("clamps below zero to 0 (scrolled above the top / overscroll)", () => {
    expect(
      stickyTopHeight({ scrollerTop: 0, documentTop: 50, barHeight: 0, contentHeight: 10000 })
    ).toBe(0);
  });

  it("clamps to contentHeight at the bottom", () => {
    expect(
      stickyTopHeight({ scrollerTop: 0, documentTop: -999999, barHeight: 0, contentHeight: 10000 })
    ).toBe(10000);
  });
});
