import { describe, expect, it } from "vitest";
import { splitExternalUrl } from "../../../src/extension/links/build-external-uri.js";

describe("splitExternalUrl", () => {
  it("preserves %2F in the path (does not collapse to /)", () => {
    const parts = splitExternalUrl("https://gitlab.com/api/v4/projects/foo%2Fbar/pipelines");
    expect(parts).not.toBeNull();
    expect(parts?.path).toBe("/api/v4/projects/foo%2Fbar/pipelines");
    expect(parts?.scheme).toBe("https");
    expect(parts?.authority).toBe("gitlab.com");
  });

  it("preserves + and %2B verbatim in the query", () => {
    const parts = splitExternalUrl("https://example.com/search?q=a+b&x=1%2B2");
    expect(parts?.query).toBe("q=a+b&x=1%2B2");
  });

  it("preserves %20 in the fragment", () => {
    const parts = splitExternalUrl("https://example.com/p#frag%20ment");
    expect(parts?.fragment).toBe("frag%20ment");
  });

  it("splits a mailto: URL preserving encoded query", () => {
    const parts = splitExternalUrl("mailto:foo@example.com?subject=a%2Fb");
    expect(parts?.scheme).toBe("mailto");
    expect(parts?.path).toBe("foo@example.com");
    expect(parts?.query).toBe("subject=a%2Fb");
  });

  it("preserves userinfo in the authority (new URL drops it from .host)", () => {
    const parts = splitExternalUrl("https://user:pw@example.com/x%2Fy");
    expect(parts?.authority).toBe("user:pw@example.com");
    expect(parts?.path).toBe("/x%2Fy");
  });

  it("preserves password-only userinfo (username-only guard would drop :pw@)", () => {
    const parts = splitExternalUrl("https://:pw@example.com/x");
    expect(parts?.authority).toBe(":pw@example.com");
  });

  it("returns null on a URL the WHATWG parser rejects", () => {
    expect(splitExternalUrl("https://")).toBeNull();
  });
});
