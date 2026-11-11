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

describe("nested emission", () => {
  it("keeps the longer-running style outermost", () => {
    expect(md([t("A", B | I), t("B", I), t("C", B)])).toBe("***A**B***C**");
  });

  it("never opens a marker right before a neutral unit (leading space)", () => {
    expect(md([t("a", B), t("a", B | I), t(" a", I)])).toBe("**a*a*** *a*");
  });

  it("never opens a marker right before a neutral unit (trailing space)", () => {
    expect(md([t("a", I), t("a ", B | I), t("a", B)])).toBe("*a**a*** **a**");
  });
});

describe("flanking repair", () => {
  it("demotes a closing colon out of the run (Note:)", () => {
    expect(md([t("Note:", B), t("text", 0)])).toBe("**Note**:text");
  });

  it("demotes both parentheses when both sides fail", () => {
    expect(md([t("x", 0), t("(a)", B), t("b", 0)])).toBe("x(**a**)b");
  });

  it("demotes CJK brackets (「重要」)", () => {
    expect(md([t("これは", 0), t("「重要」", B), t("です", 0)])).toBe("これは「**重要**」です");
  });

  it("demotes only the failing side", () => {
    expect(md([t("(a)", B), t("b", 0)])).toBe("**(a**)b");
  });

  it("treats an astral neighbour as a word character", () => {
    expect(md([t("a.", B), t("😀", 0)])).toBe("**a**.😀");
    expect(md([t("😀", 0), t("(a)", B)])).toBe("😀(**a)**");
  });

  it("classifies a closer-plus-opener marker run as one group", () => {
    expect(md([t("a", B), t("a", B | I), t("(a)", I)])).toBe("**a*a***(*a)*");
  });

  it("leaves a flanking closer before a trimmed edge alone", () => {
    expect(md([t("a.", B), t(" ", 0)], true)).toBe("**a.**");
  });
});
