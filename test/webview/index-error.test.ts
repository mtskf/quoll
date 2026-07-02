// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Synthesize an init failure: getHost throws synchronously. This is the
// vanilla ErrorBoundary replacement contract — index.ts must catch and
// paint the init-error banner instead of leaving #root blank.
vi.mock("../../src/webview/host.js", () => ({
  getHost: () => {
    throw new Error("synthetic getHost failure");
  },
  subscribeToHost: () => () => {},
}));

let root: HTMLElement | null = null;

beforeEach(() => {
  root = document.createElement("div");
  root.id = "root";
  root.dataset.nonce = "test-nonce";
  document.body.appendChild(root);
});

afterEach(() => {
  if (root) {
    root.remove();
    root = null;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("index — init-error surface (vanilla ErrorBoundary replacement)", () => {
  it("paints the init-error banner when getHost throws during mount", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Dynamic import so the mocked host.js is in place before index.ts
    // runs its top-level side effects.
    await import("../../src/webview/index.js");
    const banner = root?.querySelector(".quoll-banner.error");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Quoll webview failed to start");
    expect(banner?.textContent).toContain("synthetic getHost failure");
    // Diagnostic log fired once.
    const quollLogs = consoleSpy.mock.calls.filter(
      (args) =>
        typeof args[0] === "string" && args[0].includes("[quoll] webview crashed during init")
    );
    expect(quollLogs.length).toBe(1);
    consoleSpy.mockRestore();
  });
});
