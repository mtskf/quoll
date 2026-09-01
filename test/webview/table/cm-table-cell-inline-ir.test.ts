// @vitest-environment happy-dom
// `parseCellInline` losslessness: the IR's spans must PARTITION the source —
// ordered, contiguous, gap-free, covering — so that slicing the source by them
// and concatenating gives the input back character for character. Everything
// downstream (dimming, the source map, drag mapping) reads offsets off this IR,
// so a construct whose arm forgets a span silently shifts every offset after it.
// Two levels are pinned: the outer partition over the whole cell, and each
// leaf's own boundary spans partitioning ITS outer span (a link's brackets,
// label, parens and destination) — the level at which dimming picks characters,
// and invisible to the outer check.
// The DOM is never touched here, and the global environment is node
// (vitest.config.ts), so the pragma is not load-bearing today. It stays because
// the module under test is one import away from the renderer that IS — the
// first assertion that renders needs no pragma edit to work.
import { describe, expect, it } from "vitest";

import type { Resolved, Span } from "../../../src/webview/cm/inline/inline-emphasis.js";
import type { CellLeaf } from "../../../src/webview/cm/inline/inline-ir.js";
import { parseCellInline } from "../../../src/webview/cm/inline/inline-ir.js";

// ── parseCellInline losslessness ─────────────────────────────────────────────

// Depth-first ordered leaf spans: text spans, leaf outer spans, and for
// emphasis the openDelim span, then children (recursive), then closeDelim.
function leafSpans(ir: Resolved<CellLeaf>[]): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  for (const n of ir) {
    if (n.kind === "emphasis") {
      out.push(n.openDelim, ...leafSpans(n.children), n.closeDelim);
    } else {
      out.push(n.span);
    }
  }
  return out;
}

describe("parseCellInline losslessness", () => {
  const corpus = [
    "hello",
    "",
    "*em*",
    "**b**",
    "***t***",
    "a_b_c",
    "*a**b*",
    "**a*a*a*",
    "x \\| y",
    "`code`",
    "see [docs](https://example.com)",
    "![alt](https://x.test/i.png)",
    "<https://x.test>",
    "[bad](javascript:1)",
    "a*b©*c",
    "pre **a *b* c** post",
    "~~x~~",
    "==x==",
    "~~*x*~~",
    "a ~~b~~ ==c== d",
  ];
  for (const raw of corpus) {
    it(`partitions ${JSON.stringify(raw)} into ordered leaves that reconstruct the source`, () => {
      const spans = leafSpans(parseCellInline(raw));
      // ordered + contiguous + covering
      let cursor = 0;
      let rebuilt = "";
      for (const s of spans) {
        expect(s.from).toBe(cursor);
        rebuilt += raw.slice(s.from, s.to);
        cursor = s.to;
      }
      expect(cursor).toBe(raw.length);
      expect(rebuilt).toBe(raw);
    });
  }

  it("exposes link boundary spans for dimming", () => {
    const ir = parseCellInline("[docs](https://x.test)");
    const link = ir[0];
    if (link.kind !== "leaf" || link.leaf.kind !== "link") {
      throw new Error("expected link leaf");
    }
    expect(link.leaf.safeUrl).toBe("https://x.test");
    expect("[docs](https://x.test)".slice(link.leaf.label.from, link.leaf.label.to)).toBe("docs");
    expect("[docs](https://x.test)".slice(link.leaf.dest.from, link.leaf.dest.to)).toBe(
      "https://x.test"
    );
  });

  // Per-construct boundary spans must partition each leaf's OUTER span in source
  // order — else PR2 dims the wrong characters while the outer-span partition
  // test above still passes (Codex plan review Conf 98).
  it("each leaf's boundary spans partition its outer span in order", () => {
    const samples: Array<{ raw: string; kind: CellLeaf["kind"] }> = [
      { raw: "a\\|b", kind: "escape" },
      { raw: "`code`", kind: "code" },
      { raw: "see [docs](https://example.com)", kind: "link" },
      { raw: "![alt](https://x.test/i.png)", kind: "image" },
      { raw: "<https://x.test>", kind: "autolink" },
    ];
    for (const { raw, kind } of samples) {
      const leaves = walkLeaves(parseCellInline(raw));
      // Pin that the construct is emitted as the EXPECTED leaf kind (not folded
      // into text) — else the boundary check below is vacuous when the leaf is
      // absent (Codex re-review Conf 97).
      const matching = leaves.filter((n) => n.leaf.kind === kind);
      expect(matching).toHaveLength(1);
      let cursor = matching[0].span.from;
      for (const p of leafBoundarySpans(matching[0].leaf)) {
        expect(p.to).toBeGreaterThanOrEqual(p.from); // reject reversed/overlapping spans (Conf 95)
        expect(p.from).toBe(cursor);
        cursor = p.to;
      }
      expect(cursor).toBe(matching[0].span.to);
    }
  });

  it("pins text values and emphasis delimiter span/length/char invariants", () => {
    const raw = "pre **a *b* c** post";
    for (const n of walkAll(parseCellInline(raw))) {
      if (n.kind === "text") {
        expect(raw.slice(n.span.from, n.span.to)).toBe(n.value);
      } else if (n.kind === "emphasis") {
        expect(n.span).toEqual({ from: n.openDelim.from, to: n.closeDelim.to });
        const want = n.tag === "strong" ? 2 : 1;
        expect(n.openDelim.to - n.openDelim.from).toBe(want);
        expect(n.closeDelim.to - n.closeDelim.from).toBe(want);
        const oc = raw.slice(n.openDelim.from, n.openDelim.to);
        const cc = raw.slice(n.closeDelim.from, n.closeDelim.to);
        expect(new Set(oc).size).toBe(1); // a run of one delimiter char
        expect(oc[0]).toBe(cc[0]);
      }
    }
  });
});

// Structure helpers for the boundary/invariant tests.
type LeafNode = Extract<Resolved<CellLeaf>, { kind: "leaf" }>;
function walkLeaves(ir: Resolved<CellLeaf>[]): LeafNode[] {
  const out: LeafNode[] = [];
  for (const n of ir) {
    if (n.kind === "leaf") {
      out.push(n);
    } else if (n.kind === "emphasis") {
      out.push(...walkLeaves(n.children));
    }
  }
  return out;
}
function walkAll(ir: Resolved<CellLeaf>[]): Resolved<CellLeaf>[] {
  const out: Resolved<CellLeaf>[] = [];
  for (const n of ir) {
    out.push(n);
    if (n.kind === "emphasis") {
      out.push(...walkAll(n.children));
    }
  }
  return out;
}
function leafBoundarySpans(leaf: CellLeaf): Span[] {
  switch (leaf.kind) {
    case "escape":
      return [leaf.marker, leaf.char];
    case "code":
      return [leaf.openFence, leaf.content, leaf.closeFence];
    case "link":
      return [
        leaf.openBracket,
        leaf.label,
        leaf.closeBracket,
        leaf.openParen,
        leaf.dest,
        leaf.closeParen,
      ];
    case "image":
      return [
        leaf.bang,
        leaf.openBracket,
        leaf.alt,
        leaf.closeBracket,
        leaf.openParen,
        leaf.dest,
        leaf.closeParen,
      ];
    case "autolink":
      return [leaf.openAngle, leaf.content, leaf.closeAngle];
  }
}
