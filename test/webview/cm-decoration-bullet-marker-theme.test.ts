import { describe, expect, it } from "vitest";
import { bulletMarkerThemeSpec } from "../../src/webview/cm/theme.js";

describe("bulletMarkerThemeSpec — style contract", () => {
  it("hides the raw glyph without removing its box, and carries the first-line gap", () => {
    const marker = bulletMarkerThemeSpec[".quoll-bullet-marker"];
    // color: transparent keeps the `-`/`*`/`+` glyph in layout (advance width
    // preserved) so revealing it never shifts the content column.
    expect(marker.color).toBe("transparent");
    // position: relative makes the span the ::before marker's containing block.
    expect(marker.position).toBe("relative");
    // First-line half of the marker→text gap (list-marker-restyle). Auto-gated —
    // the span exists only caret-off.
    expect(marker.marginRight).toContain("--quoll-list-marker-gap");
  });

  it("shares ::before positioning across depths, anchored at the column edge (left: 0)", () => {
    const base = bulletMarkerThemeSpec[".quoll-bullet-marker::before"];
    expect(base.content).toBe('""');
    expect(base.position).toBe("absolute");
    // left:0 is the maximum-gap position that is still contained (a negative left
    // bleeds past the text-column edge). Real-pixel containment: browser harness.
    expect(base.left).toBe("0");
    // Out of hit-testing — decorative only.
    expect(base.pointerEvents).toBe("none");
  });

  it("depth 1 is a FILLED disc sized by the dot token (default larger than 0.34em)", () => {
    const d1 = bulletMarkerThemeSpec[".quoll-bullet-marker-d1::before"];
    expect(d1.borderRadius).toBe("50%");
    expect(d1.backgroundColor).toContain("--quoll-bullet-marker");
    // Sized by the token; the fallback pins the larger default (0.42em > old 0.34em).
    expect(d1.width).toBe("var(--quoll-bullet-dot-size, 0.6em)");
    expect(d1.height).toBe("var(--quoll-bullet-dot-size, 0.6em)");
  });

  it("depth 2 is a HOLLOW disc — outline only, no fill", () => {
    const d2 = bulletMarkerThemeSpec[".quoll-bullet-marker-d2::before"];
    expect(d2.borderRadius).toBe("50%");
    expect(d2.backgroundColor).toBe("transparent");
    // Same footprint token as d1, ring thickness from its own token.
    expect(d2.width).toBe("var(--quoll-bullet-dot-size, 0.6em)");
    expect(d2.border).toContain("--quoll-bullet-hollow-border");
    expect(d2.border).toContain("--quoll-bullet-marker");
  });

  it("depth 3+ is a DASH bar — width/height from bar tokens, not a 50% pill", () => {
    const d3 = bulletMarkerThemeSpec[".quoll-bullet-marker-d3::before"];
    expect(d3.backgroundColor).toContain("--quoll-bullet-marker");
    expect(d3.borderRadius).not.toBe("50%");
    // A horizontal bar: distinct width/height tokens (fallbacks 0.5em > 0.12em).
    expect(d3.width).toContain("--quoll-bullet-dash-width");
    expect(d3.height).toContain("--quoll-bullet-dash-height");
  });
});
