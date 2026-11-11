import { describe, expect, it } from "vitest";
import {
  BOLD,
  type InlineAtom,
  ITALIC,
  type StyleMask,
  serializeInlineRuns,
} from "../../../src/webview/cm/paste/inline-runs.js";

// A byte-for-byte copy of the converter's private `escapeInline`
// (src/webview/cm/paste/html-to-markdown.ts). The serializer takes the escaper as
// an injected option, so these unit tests pin it with the same escaping the
// converter passes in.
function escapeInline(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[`*_[\]<~=&|]/g, "\\$&");
}

const ZWJ = String.fromCharCode(0x200d); // U+200D ZERO WIDTH JOINER

const t = (text: string, style: StyleMask = 0): InlineAtom => ({ kind: "text", text, style });
const br = (style: StyleMask = 0): InlineAtom => ({ kind: "break", style });
const code = (markdown: string, style: StyleMask = 0): InlineAtom => ({
  kind: "code",
  markdown,
  style,
});

function run(atoms: readonly InlineAtom[], trimEdges = false) {
  return serializeInlineRuns(atoms, { trimEdges, escapeText: escapeInline });
}
const md = (atoms: readonly InlineAtom[], trimEdges = false): string =>
  run(atoms, trimEdges).markdown;

const B = BOLD;
const I = ITALIC;

describe("serializeInlineRuns", () => {
  it("merges adjacent runs of the same style", () => {
    expect(md([t("A", B), t("B", B)])).toBe("**AB**");
  });

  it("closes one style and opens the next at a style change", () => {
    expect(md([t("A", B), t("B", I)])).toBe("**A***B*");
  });

  it("keeps an interior space's source style", () => {
    expect(md([t("a", B), t(" ", 0), t("b", B)])).toBe("**a** **b**");
    expect(md([t("a b", B)])).toBe("**a b**");
  });

  it("drops the style of a space at a run edge", () => {
    expect(md([t("foo ", B), t("bar", 0)])).toBe("**foo** bar");
  });

  it("emits no markers and no syntax flag for a lone joiner", () => {
    expect(run([t(ZWJ, B)])).toEqual({ markdown: ZWJ, emittedSyntax: false });
  });

  it("keeps a style across a hard break inside the run", () => {
    expect(md([t("a", B), br(B), t("b", B)])).toBe("**a\\\nb**");
  });

  it("trims space and break units at the edges when asked", () => {
    expect(md([br(0), t("a", 0), t(" ", 0)], true)).toBe("a");
  });

  it("emits code spans verbatim and reports only marker syntax", () => {
    expect(run([code("`x`", 0)])).toEqual({ markdown: "`x`", emittedSyntax: false });
    expect(run([code("`x`", B)])).toEqual({ markdown: "**`x`**", emittedSyntax: true });
  });
});

const link = (label: InlineAtom[], style: StyleMask = 0, destination = "u"): InlineAtom => ({
  kind: "link",
  label,
  destination,
  style,
});

describe("link atoms", () => {
  it("serialises the label's own emphasis inside the brackets", () => {
    expect(run([link([t("x", B)])])).toEqual({ markdown: "[**x**](u)", emittedSyntax: true });
  });

  it("wraps the whole link in its outer style", () => {
    expect(md([link([t("x", 0)], B)])).toBe("**[x](u)**");
  });

  it("folds a break in the label to a single space", () => {
    expect(md([link([t("a", 0), br(0), t("b", 0)])])).toBe("[a b](u)");
  });

  it("keeps label-edge spaces (they are not segment edges)", () => {
    expect(md([link([t(" x ", 0)])], true)).toBe("[ x ](u)");
  });
});
