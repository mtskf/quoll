import { describe, expect, it } from "vitest";
import { bulletMarkerThemeSpec } from "../../src/webview/cm/theme.js";

describe("bulletMarkerThemeSpec — style contract", () => {
  it("hides the raw glyph without removing its box, and anchors the ::before dot", () => {
    const marker = bulletMarkerThemeSpec[".quoll-bullet-marker"];
    // color: transparent keeps the `-`/`*`/`+` glyph in layout (advance width
    // preserved) so revealing it never shifts the content column.
    expect(marker.color).toBe("transparent");
    // position: relative makes the span the ::before dot's containing block.
    expect(marker.position).toBe("relative");
  });

  it("paints a round dot from the --quoll-bullet-marker token", () => {
    const dot = bulletMarkerThemeSpec[".quoll-bullet-marker::before"];
    expect(dot.content).toBe('""');
    expect(dot.position).toBe("absolute");
    expect(dot.borderRadius).toBe("50%");
    // The dot colour is the Quoll-owned token (per-theme in styles.css).
    expect(dot.backgroundColor).toContain("--quoll-bullet-marker");
    // Out of hit-testing — decorative only.
    expect(dot.pointerEvents).toBe("none");
  });

  it("anchors the dot at the column edge (left: 0), not past it", () => {
    // left:-3px bled the disc 3px past the text-column left; left:0 is the
    // maximum-gap position that is still contained. The raw glyph keeps its
    // advance (color:transparent), so no caret-on/off column jump. Real-pixel
    // containment is verified in the browser harness.
    expect(bulletMarkerThemeSpec[".quoll-bullet-marker::before"].left).toBe("0");
  });
});
