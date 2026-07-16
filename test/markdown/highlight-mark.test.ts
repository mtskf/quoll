import {
  parser as baseParser,
  Emoji,
  GFM,
  Strikethrough,
  Subscript,
  Superscript,
} from "@lezer/markdown";
import { describe, expect, it } from "vitest";
import { highlightMarkExtension } from "../../src/markdown/highlight-mark.js";

// Minimal parser: just the highlight rule on CommonMark, for structural asserts.
const P = baseParser.configure([highlightMarkExtension]);
// Full parser mirroring the HOST write-gate extension set (GFM + Subscript +
// Superscript + Emoji), used for the adjacency cases below.
const FULL = baseParser.configure([GFM, Subscript, Superscript, Emoji, highlightMarkExtension]);
// A Strikethrough-only parser, to pin that Highlight's flanking behaviour
// tracks Strikethrough's byte-for-byte (both derive from the same private
// upstream `Punctuation` regex — see the flanking-parity test).
const STRIKE = baseParser.configure([Strikethrough]);

/** Collect "NodeName[from,to)" for every node in `parser.parse(src)`. */
function nodes(src: string, parser = P): string[] {
  const out: string[] = [];
  parser.parse(src).iterate({
    enter: (n) => {
      out.push(`${n.name}[${n.from},${n.to})`);
    },
  });
  return out;
}

/** True when a span node of `name` exists anywhere in the tree. */
function hasSpan(src: string, name: string, parser = P): boolean {
  return nodes(src, parser).some((n) => n.startsWith(`${name}[`));
}

describe("highlightMarkExtension", () => {
  it("parses ==text== into a Highlight span with two HighlightMark children", () => {
    const ns = nodes("==hi==");
    expect(ns).toContain("Highlight[0,6)");
    expect(ns).toContain("HighlightMark[0,2)");
    expect(ns).toContain("HighlightMark[4,6)");
  });

  it("does NOT create a Highlight for a single `=` pair", () => {
    // `=x=` → the first guard (`cx.char(pos+1) !== 61`) rejects; no delimiter.
    // Byte-parallel to Strikethrough rejecting a single `~` (pinned below).
    expect(hasSpan("=hi=", "Highlight")).toBe(false);
  });

  it("still parses inline content inside a highlight (nested emphasis)", () => {
    // `==*x*==` is 7 chars: Highlight[0,7), inner Emphasis preserved.
    const ns = nodes("==*x*==");
    expect(ns).toContain("Highlight[0,7)");
    expect(ns).toContain("HighlightMark[0,2)");
    expect(ns).toContain("HighlightMark[5,7)");
    expect(ns.some((n) => n.startsWith("Emphasis["))).toBe(true);
  });

  // The flanking rules are a verbatim copy of upstream's private `Punctuation`
  // regex. Pin that Highlight opens/closes at EXACTLY the same offsets
  // Strikethrough does across whitespace / punctuation flanking, so if a future
  // @lezer/markdown release changes `Punctuation`, Strikethrough moves too and
  // this parity test reds — the drift-detection we cannot get from the private
  // regex directly. Scoped to the common `==body==` shape (the three-`=` edge
  // deliberately diverges from Strikethrough — see the next test).
  it("Highlight flanking tracks Strikethrough byte-for-byte", () => {
    for (const body of ["x", " x ", "a x", "x b", "word", "*em*", "с"]) {
      const hi = `==${body}==`;
      const st = `~~${body}~~`;
      const hiMarks = nodes(hi)
        .filter((n) => n.startsWith("HighlightMark["))
        .map((n) => n.replace("HighlightMark", "MARK"));
      const stMarks = nodes(st, STRIKE)
        .filter((n) => n.startsWith("StrikethroughMark["))
        .map((n) => n.replace("StrikethroughMark", "MARK"));
      expect(hiMarks, `flanking mismatch for body=${JSON.stringify(body)}`).toEqual(stMarks);
    }
  });

  // Three-delimiter edge, pinned to MEASURED behaviour (verified empirically
  // against real @lezer/markdown), NOT to Strikethrough: the `cx.char(pos+2) ===
  // 61` guard is byte-identical to Strikethrough's three-tilde guard, but
  // Highlight and Strikethrough DIVERGE at start-of-input (`===x===` →
  // Highlight[1,7) wrapping `=x=`, whereas `~~~x~~~` → NO Strikethrough). So do
  // NOT assert "no Highlight for three `=`" (false) nor Strikethrough parity for
  // `===`. Pin the actual spans:
  it("forms a Highlight around the inner =x= for ===x=== (measured, not === rejection)", () => {
    // `===x===` (7 chars): parser rescans from pos+1, opens at [1,3), closes at [5,7).
    const ns = nodes("===x===");
    expect(ns).toContain("Highlight[1,7)");
    // Mid-paragraph three-`=` also forms a highlight around the inner run.
    expect(nodes("a ===x=== b")).toContain("Highlight[3,9)");
  });

  // Adjacency with the host's other inline extensions. `after: "Emphasis"`
  // orders the delimiter scan; confirm a highlight still forms when it wraps /
  // abuts Subscript, Superscript, and Emoji tokens.
  it("forms a Highlight adjacent to Subscript / Superscript / Emoji", () => {
    expect(hasSpan("==x~sub~==", "Highlight", FULL)).toBe(true);
    expect(hasSpan("==x~sub~==", "Subscript", FULL)).toBe(true);
    expect(hasSpan("==x^sup^==", "Highlight", FULL)).toBe(true);
    expect(hasSpan("==x^sup^==", "Superscript", FULL)).toBe(true);
    expect(hasSpan("==:smile:==", "Highlight", FULL)).toBe(true);
  });
});
