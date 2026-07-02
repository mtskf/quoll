import { describe, expect, it } from "vitest";

import { isAllowedUrl } from "../../src/markdown/url-allowlist.js";
import { decodeMarkdownDestination } from "../../src/markdown/url-decode.js";

describe("decodeMarkdownDestination (smoke — full attack matrix lives in lezer-url-walker.test.ts)", () => {
  it("strips surrounding angle brackets", () => {
    expect(decodeMarkdownDestination("<https://example.com>")).toBe("https://example.com");
  });

  it("undoes backslash escapes", () => {
    expect(decodeMarkdownDestination("javascript\\:alert(1)")).toBe("javascript:alert(1)");
  });

  it("decodes numeric character references", () => {
    expect(decodeMarkdownDestination("javascript&#58;alert(1)")).toBe("javascript:alert(1)");
  });

  it("decodes hex character references", () => {
    expect(decodeMarkdownDestination("javascript&#x3A;alert(1)")).toBe("javascript:alert(1)");
  });

  it("decodes URL-impactful named entities (case-insensitive)", () => {
    expect(decodeMarkdownDestination("javascript&colon;alert(1)")).toBe("javascript:alert(1)");
    expect(decodeMarkdownDestination("javascript&COLON;alert(1)")).toBe("javascript:alert(1)");
  });

  it("returns relative paths unchanged", () => {
    expect(decodeMarkdownDestination("/relative/path")).toBe("/relative/path");
    expect(decodeMarkdownDestination("#frag")).toBe("#frag");
  });

  it("returns http/https URLs unchanged when no escapes are present", () => {
    expect(decodeMarkdownDestination("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1"
    );
  });

  // Regression: NAMED_ENTITIES is a plain object literal, so a bare
  // `LOOKUP[name] ?? SUBSTITUTE` resolves `Object.prototype` member names
  // (`constructor` is the one that survives the `.toLowerCase()` fold) to the
  // inherited native function instead of failing closed — the function source
  // carries no `:` scheme, so isAllowedUrl would classify it as a relative
  // path and ALLOW it. The decoder must treat every unknown named entity —
  // prototype member names included — as undecodable and substitute NUL.
  it("decodes Object.prototype member-named entities to the NUL substitute, not inherited functions", () => {
    expect(decodeMarkdownDestination("&constructor;")).toBe("\u0000");
    expect(decodeMarkdownDestination("&CONSTRUCTOR;")).toBe("\u0000");
    expect(decodeMarkdownDestination("&toString;")).toBe("\u0000");
    expect(decodeMarkdownDestination("&valueOf;")).toBe("\u0000");
  });

  it("rejects a URL whose scheme is hidden behind an Object.prototype member-named entity", () => {
    const decoded = decodeMarkdownDestination("javascript&constructor;alert(1)");
    expect(isAllowedUrl(decoded)).toBe(false);
  });
});
