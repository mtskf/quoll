// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { patchPersistedState, readPersistedState } from "../../src/webview/host.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("host persisted view-state", () => {
  it("returns {} and no-ops when acquireVsCodeApi is absent (tests / non-webview)", () => {
    expect(readPersistedState()).toEqual({});
    expect(() => patchPersistedState({ outlineWidthPx: 320 })).not.toThrow();
  });

  it("read-modify-writes through a single memoized WebviewApi handle", async () => {
    let backing: Record<string, unknown> | undefined;
    const api = {
      getState: () => backing,
      setState: (s: Record<string, unknown>) => {
        backing = s;
        return s;
      },
      postMessage: vi.fn(),
    };
    const acquire = vi.fn(() => api);
    vi.stubGlobal("acquireVsCodeApi", acquire);
    // Fresh module so the memoized handle picks up the stub.
    vi.resetModules();
    const host = await import("../../src/webview/host.js");
    host.patchPersistedState({ outlineWidthPx: 320 });
    expect(host.readPersistedState()).toEqual({ outlineWidthPx: 320 });
    host.patchPersistedState({ other: 1 }); // shallow-merge, not clobber
    expect(host.readPersistedState()).toEqual({ outlineWidthPx: 320, other: 1 });
    expect(acquire).toHaveBeenCalledTimes(1); // single acquire
  });

  it("swallows a throwing getState/setState (never throws — Codex F1)", async () => {
    const api = {
      getState: () => {
        throw new Error("state backend exploded");
      },
      setState: () => {
        throw new Error("state backend exploded");
      },
      postMessage: vi.fn(),
    };
    vi.stubGlobal(
      "acquireVsCodeApi",
      vi.fn(() => api)
    );
    vi.resetModules();
    const host = await import("../../src/webview/host.js");
    expect(host.readPersistedState()).toEqual({}); // degrades to empty, no throw
    expect(() => host.patchPersistedState({ outlineWidthPx: 320 })).not.toThrow();
  });

  it("soft persistence does NOT poison the getHost() failure cache (Codex F2)", async () => {
    // No acquireVsCodeApi: a soft read must not cache a failure that a LATER
    // getHost() (after the API appears) would keep throwing from.
    vi.resetModules();
    const host = await import("../../src/webview/host.js");
    expect(host.readPersistedState()).toEqual({}); // soft path, unavailable
    // Now the API appears (e.g. re-eval order). getHost must succeed, not throw
    // a cached "not defined".
    const api = { getState: () => undefined, setState: (s: unknown) => s, postMessage: vi.fn() };
    vi.stubGlobal(
      "acquireVsCodeApi",
      vi.fn(() => api)
    );
    expect(() => host.getHost()).not.toThrow();
  });

  it("a hard getHost() failure stays terminal — a later soft acquire can't un-fail it (Codex re-review)", async () => {
    // getHost fails FIRST (no API) → caches the failure. Even if the API then
    // appears and a soft read populates the handle, getHost must keep throwing
    // the SAME error identity (anti-banner-thrash contract).
    vi.resetModules();
    const host = await import("../../src/webview/host.js");
    let firstError: unknown;
    try {
      host.getHost();
    } catch (e) {
      firstError = e;
    }
    expect(firstError).toBeInstanceOf(Error);
    // API appears; a soft read would otherwise populate rawApi.
    const api = { getState: () => ({}), setState: (s: unknown) => s, postMessage: vi.fn() };
    vi.stubGlobal(
      "acquireVsCodeApi",
      vi.fn(() => api)
    );
    expect(host.readPersistedState()).toEqual({}); // soft path bails on the cached failure
    expect(() => host.getHost()).toThrow(); // still throws
    try {
      host.getHost();
    } catch (e) {
      expect(e).toBe(firstError); // SAME identity, not a fresh ReferenceError
    }
  });
});
