// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { renderBanners } from "../../src/webview/banners.js";
import { initialState, type WebviewState } from "../../src/webview/state.js";

function state(overrides: Partial<WebviewState> = {}): WebviewState {
  return { ...initialState, ready: true, docVersion: 1, canWrite: true, ...overrides };
}

const internalError = "Could not send edit to host: transport failed";

describe("renderBanners", () => {
  it("renders nothing when no error state is set", () => {
    const host = document.createElement("div");
    renderBanners(host, state());
    expect(host.children.length).toBe(0);
  });

  it("renders the send-failure banner with role=alert", () => {
    const host = document.createElement("div");
    renderBanners(host, state({ sendFailure: internalError }));
    const banner = host.querySelector(".quoll-banner.error");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Cannot send edit");
    expect(banner?.textContent).toContain("transport failed");
  });

  it("replaces children on each call (no append leakage)", () => {
    const host = document.createElement("div");
    renderBanners(host, state({ sendFailure: internalError }));
    expect(host.children.length).toBe(1);
    renderBanners(host, state({ sendFailure: internalError }));
    expect(host.children.length).toBe(1);
    renderBanners(host, state());
    expect(host.children.length).toBe(0);
  });
});
