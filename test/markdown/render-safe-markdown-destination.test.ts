import { describe, expect, it } from "vitest";

import { renderSafeMarkdownDestination } from "../../src/markdown/render-safe-markdown-destination.js";

describe("renderSafeMarkdownDestination (shared render-side decode→gate choke point)", () => {
  it("passes a safe https destination through", () => {
    expect(renderSafeMarkdownDestination("https://example.com/a.png")).toEqual({
      kind: "safe",
      url: "https://example.com/a.png",
    });
  });

  it("accepts a relative destination (schemeless → safe)", () => {
    expect(renderSafeMarkdownDestination("./img/a.png")).toEqual({
      kind: "safe",
      url: "./img/a.png",
    });
  });

  it("blocks a bare javascript: scheme", () => {
    expect(renderSafeMarkdownDestination("javascript:alert(1)")).toEqual({ kind: "blocked" });
  });

  it("blocks entity- and backslash-encoded javascript: schemes (decode runs first)", () => {
    expect(renderSafeMarkdownDestination("javascript&#58;alert(1)")).toEqual({ kind: "blocked" });
    expect(renderSafeMarkdownDestination("javascript&colon;alert(1)")).toEqual({ kind: "blocked" });
    expect(renderSafeMarkdownDestination("javascript&COLON;alert(1)")).toEqual({ kind: "blocked" });
    expect(renderSafeMarkdownDestination("javascript&#58alert(1)")).toEqual({ kind: "blocked" }); // semicolonless numeric
    expect(renderSafeMarkdownDestination("javascript\\:alert(1)")).toEqual({ kind: "blocked" });
  });

  // Fail-closed posture inherited from decodeMarkdownDestination's NUL
  // substitution — the axis where the old table-cell decoder failed OPEN.
  it("blocks an unknown-named-entity scheme bypass (undecodable → NUL → C0 reject)", () => {
    expect(renderSafeMarkdownDestination("javascript&unknownentity;:alert(1)")).toEqual({
      kind: "blocked",
    });
  });

  it("blocks a lone-surrogate character reference (undecodable → NUL → C0 reject)", () => {
    expect(renderSafeMarkdownDestination("javascript&#xD800;:alert(1)")).toEqual({
      kind: "blocked",
    });
  });

  it("does not over-block plain multi-parameter query URLs (no trailing ; → not consumed)", () => {
    expect(renderSafeMarkdownDestination("https://x.test/?a=1&b=2&utm_source=z")).toEqual({
      kind: "safe",
      url: "https://x.test/?a=1&b=2&utm_source=z",
    });
  });

  it("decodes &amp; in a safe query and keeps it safe", () => {
    expect(renderSafeMarkdownDestination("https://x.test/?q=a&amp;b")).toEqual({
      kind: "safe",
      url: "https://x.test/?q=a&b",
    });
  });

  // OVER-BLOCK POLICY (Codex Conf 95): a safe-scheme URL carrying a
  // semicolon-terminated named entity OUTSIDE the curated URL-impactful set
  // (`&copy;`) is undecodable → NUL → blocked. This is intended: it aligns
  // table-cell render with the write-gate (which makes such a URL
  // non-persistable) and the block-image render-gate. Pinned so it is visibly
  // deliberate, not an accident.
  it("blocks a safe-scheme URL containing a non-curated named entity (&copy;) — over-block policy", () => {
    expect(renderSafeMarkdownDestination("https://x.test/?q=a&copy;b")).toEqual({
      kind: "blocked",
    });
  });
});
