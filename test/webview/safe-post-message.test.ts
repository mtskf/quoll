import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSwitchToTextMessage } from "../../src/shared/protocol.js";
import { type PostMessageHost, safePostMessage } from "../../src/webview/safe-post-message.js";

const message = buildSwitchToTextMessage();

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safePostMessage", () => {
  it("posts the message and returns true on success", () => {
    const post = vi.fn();
    const onError = vi.fn();
    const host: PostMessageHost = { postMessage: post };

    expect(safePostMessage(host, message, "test", onError)).toBe(true);
    expect(post).toHaveBeenCalledWith(message);
    expect(onError).not.toHaveBeenCalled();
  });

  it("logs, invokes onError, and returns false on a transport throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = new Error("post boom");
    const host: PostMessageHost = {
      postMessage: () => {
        throw boom;
      },
    };
    const onError = vi.fn();

    expect(safePostMessage(host, message, "test", onError)).toBe(false);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  // Invariant: safePostMessage MUST NOT throw out of a keymap command, even
  // when a caller's onError itself throws (guards the "logs, never throws"
  // contract the cm/* callers depend on).
  it("does not re-throw when onError throws, and still returns false", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const host: PostMessageHost = {
      postMessage: () => {
        throw new Error("post boom");
      },
    };
    const onError = () => {
      throw new Error("onError boom");
    };

    let result: boolean | undefined;
    expect(() => {
      result = safePostMessage(host, message, "test", onError);
    }).not.toThrow();
    expect(result).toBe(false);
  });
});
