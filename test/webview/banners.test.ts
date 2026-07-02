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
    renderBanners(host, state(), false);
    expect(host.children.length).toBe(0);
  });

  it("renders the serialize-error banner with role=alert", () => {
    const host = document.createElement("div");
    renderBanners(host, state({ serializeError: internalError }), false);
    const banner = host.querySelector(".quoll-banner.error");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("Cannot save");
    expect(banner?.textContent).toContain("host send failed");
  });

  it("replaces children on each call (no append leakage)", () => {
    const host = document.createElement("div");
    renderBanners(host, state({ serializeError: internalError }), false);
    expect(host.children.length).toBe(1);
    renderBanners(host, state({ serializeError: internalError }), false);
    expect(host.children.length).toBe(1);
    renderBanners(host, state(), false);
    expect(host.children.length).toBe(0);
  });
});

describe("renderBanners — persistence-degraded notice", () => {
  it("renders nothing for persistence when the flag is false", () => {
    const host = document.createElement("div");
    renderBanners(host, state(), false);
    expect(host.querySelector('[data-kind="persistence-degraded"]')).toBeNull();
  });

  it("renders a role=status notice when persistenceDegraded is true", () => {
    const host = document.createElement("div");
    renderBanners(host, state(), true);
    const notice = host.querySelector('[data-kind="persistence-degraded"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute("role")).toBe("status");
    expect(notice?.classList.contains("notice")).toBe(true);
    expect(notice?.textContent?.toLowerCase()).toContain("session");
  });

  it("clears the notice when the flag flips back to false", () => {
    const host = document.createElement("div");
    renderBanners(host, state(), true);
    expect(host.querySelector('[data-kind="persistence-degraded"]')).not.toBeNull();
    renderBanners(host, state(), false);
    expect(host.querySelector('[data-kind="persistence-degraded"]')).toBeNull();
  });

  it("renders both serialize-error and persistence notice together (error first)", () => {
    const host = document.createElement("div");
    renderBanners(host, state({ serializeError: internalError }), true);
    expect(host.children.length).toBe(2);
    expect(host.children[0].classList.contains("error")).toBe(true);
    expect(host.children[1].getAttribute("data-kind")).toBe("persistence-degraded");
  });
});
