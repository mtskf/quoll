// @vitest-environment happy-dom
//
// host.ts is the typed wrapper over the VS Code webview API. Every OTHER
// webview test `vi.mock`s it out, so its real code — the `getHost` singleton
// and the `subscribeToHost` boundary validator — ran under no test at all
// (V-M14). This suite exercises the real module: it does NOT mock host.ts.
//
// `getHost` memoizes the once-acquired API at module scope, so each singleton
// scenario imports a FRESH module via vi.resetModules() + dynamic import.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type DocumentMessage,
  type HostToWebview,
  PROTOCOL_VERSION,
} from "../../src/shared/protocol.js";

type HostModule = typeof import("../../src/webview/host.js");

// `acquireVsCodeApi` is a global the webview host injects exactly once per
// frame. Tests stub it on globalThis and clear it afterwards so module-scope
// memo state never leaks between scenarios.
const globalAny = globalThis as { acquireVsCodeApi?: unknown };

async function freshHost(): Promise<HostModule> {
  vi.resetModules();
  return import("../../src/webview/host.js");
}

afterEach(() => {
  globalAny.acquireVsCodeApi = undefined;
  vi.restoreAllMocks();
});

describe("getHost — once-per-frame singleton", () => {
  it("memoizes the acquired API and never re-acquires", async () => {
    const postMessage = vi.fn();
    const acquire = vi.fn(() => ({ postMessage }));
    globalAny.acquireVsCodeApi = acquire;

    const { getHost } = await freshHost();
    const a = getHost();
    const b = getHost();

    // Same handle for every caller, and acquireVsCodeApi was called once —
    // a second call would throw in a real webview (double-acquire guard).
    expect(a).toBe(b);
    expect(acquire).toHaveBeenCalledTimes(1);

    // The wrapper delegates to the raw API.
    a.postMessage({ protocol: PROTOCOL_VERSION, type: "ready" });
    expect(postMessage).toHaveBeenCalledWith({ protocol: PROTOCOL_VERSION, type: "ready" });
  });

  it("throws a stable error when acquireVsCodeApi is absent and caches it", async () => {
    globalAny.acquireVsCodeApi = undefined;
    const { getHost } = await freshHost();

    let first: unknown;
    let second: unknown;
    try {
      getHost();
    } catch (e) {
      first = e;
    }
    try {
      getHost();
    } catch (e) {
      second = e;
    }

    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toMatch(/acquireVsCodeApi is not defined/);
    // Same Error identity on every call (acquireFailed cache) — index.ts's
    // init-error catch must not see a fresh Error per call and thrash the banner.
    expect(second).toBe(first);
  });

  it("caches the failure when acquireVsCodeApi itself throws", async () => {
    const boom = new Error("acquire blew up");
    globalAny.acquireVsCodeApi = () => {
      throw boom;
    };
    const { getHost } = await freshHost();

    let first: unknown;
    let second: unknown;
    try {
      getHost();
    } catch (e) {
      first = e;
    }
    try {
      getHost();
    } catch (e) {
      second = e;
    }

    expect(first).toBe(boom);
    expect(second).toBe(first);
  });

  it("wraps a non-Error throw from acquireVsCodeApi as an Error", async () => {
    globalAny.acquireVsCodeApi = () => {
      // biome-ignore lint/style/useThrowOnlyError: deliberately exercises host.ts's non-Error -> `new Error(String(err))` wrapping branch.
      throw "stringy failure";
    };
    const { getHost } = await freshHost();

    let caught: unknown;
    try {
      getHost();
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("stringy failure");
  });
});

describe("subscribeToHost — boundary validation + diagnostics", () => {
  const validDoc = (): DocumentMessage => ({
    protocol: PROTOCOL_VERSION,
    type: "document",
    content: "# hi",
    docVersion: 1,
    themeKind: "dark",
    canWrite: true,
  });

  let subscribeToHost: HostModule["subscribeToHost"];
  let handler: ReturnType<typeof vi.fn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let unsubscribe: () => void;

  beforeEach(async () => {
    ({ subscribeToHost } = await freshHost());
    handler = vi.fn();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    unsubscribe = subscribeToHost(handler as (message: HostToWebview) => void);
  });

  afterEach(() => {
    unsubscribe();
  });

  it("invokes the handler for a valid host message and logs nothing", () => {
    const msg = validDoc();
    window.dispatchEvent(new MessageEvent("message", { data: msg }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(msg);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("rejects and logs a protocol mismatch without invoking the handler", () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          protocol: 2,
          type: "document",
          content: "x",
          docVersion: 1,
          themeKind: "dark",
          canWrite: true,
        },
      })
    );

    expect(handler).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, detail] = errorSpy.mock.calls[0];
    expect(String(message)).toContain("protocol mismatch");
    expect(detail).toMatchObject({ expected: PROTOCOL_VERSION, got: 2, type: "document" });
  });

  it("rejects and logs a shapeless payload via the validator branch, previewing only type + keys", () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { hello: "world", secret: "sensitive-value" } })
    );

    expect(handler).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message, detail] = errorSpy.mock.calls[0];
    expect(String(message)).toContain("rejected by validator");
    expect(detail).toEqual({ type: undefined, keys: ["hello", "secret"] });
    // The raw payload value must never reach the console — only its shape.
    expect(JSON.stringify(detail)).not.toContain("sensitive-value");
  });

  it("logs an undefined payload as an empty payload, not a validator rejection", () => {
    // A real `window.postMessage(undefined)` delivers event.data === undefined.
    // The MessageEvent constructor normalises {data: undefined} to null, so
    // reproduce the production shape by overriding the own property.
    const event = new MessageEvent("message", {});
    Object.defineProperty(event, "data", { value: undefined, configurable: true });
    window.dispatchEvent(event);

    expect(handler).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = String(errorSpy.mock.calls[0][0]);
    // Triage fix: an empty payload must not read as a malformed-but-present
    // message ("rejected by validator").
    expect(logged).toContain("empty payload");
    expect(logged).not.toContain("rejected by validator");
  });

  it("stops delivering after unsubscribe", () => {
    unsubscribe();
    window.dispatchEvent(new MessageEvent("message", { data: validDoc() }));
    expect(handler).not.toHaveBeenCalled();
  });
});
