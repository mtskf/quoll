// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { OutlineHeading } from "../../src/webview/cm/outline/build-outline.js";
import { activeStickyHeading } from "../../src/webview/cm/sticky-heading/active-heading.js";

function h(from: number, level: number, text: string): OutlineHeading {
  return { from, level, text, line: from, depth: level - 1 };
}

describe("activeStickyHeading", () => {
  const headings = [h(0, 1, "Alpha"), h(100, 2, "Beta"), h(200, 2, "Gamma")];

  it("returns null when there are no headings", () => {
    expect(activeStickyHeading([], 50)).toBeNull();
  });

  it("returns null when the top-visible line is above every heading", () => {
    expect(activeStickyHeading(headings, 0)).toBeNull();
  });

  it("returns the enclosing section heading when scrolled into a section", () => {
    expect(activeStickyHeading(headings, 50)?.text).toBe("Alpha");
    expect(activeStickyHeading(headings, 150)?.text).toBe("Beta");
    expect(activeStickyHeading(headings, 999)?.text).toBe("Gamma");
  });

  it("shows the nearest heading ABOVE while a heading's own line is top-visible (strict <)", () => {
    expect(activeStickyHeading(headings, 100)?.text).toBe("Alpha");
    expect(activeStickyHeading(headings, 101)?.text).toBe("Beta");
  });

  it("returns the last heading when several are strictly above", () => {
    expect(activeStickyHeading(headings, 201)?.text).toBe("Gamma");
  });
});
