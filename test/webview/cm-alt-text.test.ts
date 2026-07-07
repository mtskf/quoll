// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { commonMarkAltText } from "../../src/webview/cm/inline/inline-ir.js";

describe("commonMarkAltText", () => {
  it("passes plain text through unchanged", () => {
    expect(commonMarkAltText("my logo")).toBe("my logo");
  });

  it("returns empty string for empty input", () => {
    expect(commonMarkAltText("")).toBe("");
  });

  it("flattens emphasis markers (*em* -> em)", () => {
    expect(commonMarkAltText("*em*")).toBe("em");
  });

  it("flattens strong emphasis (**bold** x -> bold x)", () => {
    expect(commonMarkAltText("**bold** x")).toBe("bold x");
  });

  it("decodes a backslash escape (a\\*b -> a*b)", () => {
    expect(commonMarkAltText("a\\*b")).toBe("a*b");
  });

  it("decodes a named character reference (a&amp;b -> a&b)", () => {
    expect(commonMarkAltText("a&amp;b")).toBe("a&b");
  });

  it("decodes a numeric character reference (&#39; -> ')", () => {
    expect(commonMarkAltText("it&#39;s")).toBe("it's");
  });

  it("decodes a hex character reference (&#x27; -> ')", () => {
    expect(commonMarkAltText("it&#x27;s")).toBe("it's");
  });

  it("leaves an unknown named entity literal (display-safe)", () => {
    expect(commonMarkAltText("a&bogus;b")).toBe("a&bogus;b");
  });

  it("leaves a surrogate/out-of-range numeric reference literal", () => {
    expect(commonMarkAltText("x&#xD800;y")).toBe("x&#xD800;y");
  });

  it("keeps code-span content literal and does NOT decode entities inside it", () => {
    expect(commonMarkAltText("a `&amp;` b")).toBe("a &amp; b");
  });

  it("flattens a nested link to its label text", () => {
    expect(commonMarkAltText("see [the *docs*](https://x.test)")).toBe("see the docs");
  });

  it("flattens emphasis around an entity together", () => {
    expect(commonMarkAltText("*a&amp;b*")).toBe("a&b");
  });

  it("decodes a common named display entity (&copy; -> U+00A9)", () => {
    expect(commonMarkAltText("a&copy;b")).toBe(`a${String.fromCharCode(0xa9)}b`);
  });

  it("decodes &nbsp; to U+00A0 (no-break space, matching the comment)", () => {
    expect(commonMarkAltText("a&nbsp;b")).toBe(`a${String.fromCharCode(0xa0)}b`);
  });

  it("flattens a nested image to its alt text (not its URL)", () => {
    // CommonMark: an image alt contributes the alt of any nested image.
    expect(commonMarkAltText("foo ![bar](https://x.test/b.png)")).toBe("foo bar");
  });

  it("leaves Object.prototype names literal (&constructor; / &toString; not a function)", () => {
    // A plain-object lookup would return the inherited function for these names;
    // they must stay literal like any other unknown entity.
    expect(commonMarkAltText("a&constructor;b")).toBe("a&constructor;b");
    expect(commonMarkAltText("a&toString;b")).toBe("a&toString;b");
  });

  it("does not overflow on pathologically deep emphasis (image-alt DoS vector)", () => {
    // `![*a *b …](x)` style: ~N/2-deep emphasis inside an image alt. The
    // flatten walker must fall back to inert literal source past the cap.
    const N = 40000;
    const deep = `${"*".repeat(N)}a${"*".repeat(N)}`;
    let alt = "";
    expect(() => {
      alt = commonMarkAltText(deep);
    }).not.toThrow();
    // Content survives (the literal `a`); the inert-source fallback fired, so
    // literal `*` delimiters leak into the flattened text.
    expect(alt).toContain("a");
    expect(alt).toContain("*");
    // Non-vacuity vs the defense-in-depth try/catch: the WALKER cap emits only
    // the emphasis span at depth 100 (the outer ~2×cap delimiters are unwrapped
    // first), so the result is strictly shorter than the raw input. The
    // try/catch fallback would instead return the FULL raw string — this pins
    // that the cap path ran, not that an overflow was silently caught.
    expect(alt.length).toBeLessThan(deep.length);
  });
});
