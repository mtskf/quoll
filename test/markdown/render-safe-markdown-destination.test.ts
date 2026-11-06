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

  // Non-curated named entities decode to NUL, so this destination is blocked at render.
  it("blocks a safe-scheme URL containing a non-curated named entity (&copy;) — over-block policy", () => {
    expect(renderSafeMarkdownDestination("https://x.test/?q=a&copy;b")).toEqual({
      kind: "blocked",
    });
  });
});

describe("destination attack slices", () => {
  it.each([
    ["<javascript:alert(1)>", "javascript:alert(1)"],
    ["javascript\\:alert(1)", "javascript:alert(1)"],
    ["javascript\\&colon;alert(1)", "javascript:alert(1)"],
    ["javascript&#58;alert(1)", "javascript:alert(1)"],
    ["javascript&#58alert(1)", "javascript:alert(1)"],
    ["javascript&#x3A;alert(1)", "javascript:alert(1)"],
    ["javascript&#X3A;alert(1)", "javascript:alert(1)"],
    ["javascript&#x3A:alert(1)", "javascript::alert(1)"],
    ["jav&#x61;script:alert(1)", "javascript:alert(1)"],
    ["javascript&COLON;alert(1)", "javascript:alert(1)"],
    ["foo&plus;bar&colon;x", "foo+bar:x"],
    ["foo&period;bar&colon;x", "foo.bar:x"],
    ["java&tab;script:1", "java\tscript:1"],
    ["java&NewLine;script:1", "java\nscript:1"],
    ["java&newline;script:1", "java\nscript:1"],
    ["javascript&unknownentity;:1", "javascript\u0000:1"],
    ["https://x/&#x110000;", "https://x/\u0000"],
    ["javascript&#xD800;:1", "javascript\u0000:1"],
    ["java&#0;script:1", "java\u0000script:1"],
    ["java\u0000script:1", "java\u0000script:1"],
    ["//evil.test/x", "//evil.test/x"],
  ])("handles %j", (raw, _decoded) => {
    expect(renderSafeMarkdownDestination(raw)).toEqual({ kind: "blocked" });
  });
});
