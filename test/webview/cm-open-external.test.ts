// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { PROTOCOL_VERSION, type WebviewToHost } from "../../src/shared/protocol.js";
import { openExternalSinkFor } from "../../src/webview/cm/open-external.js";

describe("openExternalSinkFor", () => {
  it("posts an open-external envelope for an https href", () => {
    const posted: WebviewToHost[] = [];
    openExternalSinkFor({ postMessage: (m) => posted.push(m) })("https://example.com");
    expect(posted).toEqual([
      { protocol: PROTOCOL_VERSION, type: "open-external", href: "https://example.com" },
    ]);
  });

  it("posts an open-external envelope for a mailto href", () => {
    const posted: WebviewToHost[] = [];
    openExternalSinkFor({ postMessage: (m) => posted.push(m) })("mailto:a@b.test");
    expect(posted).toEqual([
      { protocol: PROTOCOL_VERSION, type: "open-external", href: "mailto:a@b.test" },
    ]);
  });

  it("drops (no post) a non-allowlisted href — fail-closed defense in depth", () => {
    const posted: WebviewToHost[] = [];
    openExternalSinkFor({ postMessage: (m) => posted.push(m) })("javascript:alert(1)");
    expect(posted).toEqual([]);
  });

  it("swallows a postMessage transport throw (does not propagate)", () => {
    const sink = openExternalSinkFor({
      postMessage: () => {
        throw new Error("transport detached");
      },
    });
    expect(() => sink("https://example.com")).not.toThrow();
  });
});
