// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import type { MarkdownError } from "../../src/markdown/errors.js";
import { renderBanners } from "../../src/webview/banners.js";
import { initialState, type WebviewState } from "../../src/webview/state.js";

function state(overrides: Partial<WebviewState> = {}): WebviewState {
  return { ...initialState, ready: true, docVersion: 1, canWrite: true, ...overrides };
}

const internalError: MarkdownError = { code: "internal_error", message: "host send failed" };

describe("renderBanners", () => {
  it("renders nothing when no error state is set", () => {
    const host = document.createElement("div");
    renderBanners(host, state());
    expect(host.children.length).toBe(0);
  });

  it("renders the serialize-error banner with role=alert", () => {
    const host = document.createElement("div");
    renderBanners(host, state({ serializeError: internalError }));
    const banner = host.querySelector(".quoll-banner.error");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Cannot save");
    expect(banner?.textContent).toContain("host send failed");
  });

  it("replaces children on each call (no append leakage)", () => {
    const host = document.createElement("div");
    renderBanners(host, state({ serializeError: internalError }));
    expect(host.children.length).toBe(1);
    renderBanners(host, state({ serializeError: internalError }));
    expect(host.children.length).toBe(1);
    renderBanners(host, state());
    expect(host.children.length).toBe(0);
  });
});
