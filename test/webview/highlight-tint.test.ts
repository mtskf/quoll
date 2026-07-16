import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { highlightTag } from "../../src/markdown/highlight-mark.js";
import { quollHighlightSpec } from "../../src/webview/cm/theme.js";

// Pins the ==highlight== mark's PAINT, not just its parse/reveal. The parse
// structure (highlight-mark.test.ts), host↔webview parity (highlight-parity)
// and mark hide/reveal (cm-decoration-inline-mark) are all covered, but the
// actual visible output — the highlightTag → background TagStyle plus the
// per-theme --quoll-highlight-bg token — had no test, so a refactor dropping
// either could ship a silently unstyled highlight with every other test green.
describe("==highlight== tint is styled (paint pinned, not only parse/reveal)", () => {
  const css = readFileSync(new URL("../../src/webview/styles.css", import.meta.url), "utf8");

  it("declares --quoll-highlight-bg for dark, light, and high-contrast themes", () => {
    // One declaration per theme block so the mark tint is theme-complete.
    const decls = css.match(/--quoll-highlight-bg\s*:/g) ?? [];
    expect(decls.length).toBeGreaterThanOrEqual(3);
  });

  it("maps highlightTag to a --quoll-highlight-bg backgroundColor in quollHighlightSpec", () => {
    const entry = quollHighlightSpec.find((s) => s.tag === highlightTag);
    expect(entry, "quollHighlightSpec must carry a highlightTag entry").toBeDefined();
    expect(entry?.backgroundColor).toMatch(/var\(--quoll-highlight-bg/);
  });
});
