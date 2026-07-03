// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { ThematicBreakWidget } from "../../src/webview/cm/decorations/thematic-break-widget.js";

describe("ThematicBreakWidget", () => {
  it("renders a separator span with the quoll-thematic-break class", () => {
    const dom = new ThematicBreakWidget().toDOM();
    expect(dom.tagName).toBe("SPAN");
    expect(dom.classList.contains("quoll-thematic-break")).toBe(true);
    expect(dom.getAttribute("role")).toBe("separator");
  });

  it("all instances are eq (stateless widget — CM can reuse DOM)", () => {
    expect(new ThematicBreakWidget().eq(new ThematicBreakWidget())).toBe(true);
  });

  it("ignores events (non-interactive, display-only)", () => {
    expect(new ThematicBreakWidget().ignoreEvent()).toBe(true);
  });
});
