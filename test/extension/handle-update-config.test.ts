import { describe, expect, it, vi } from "vitest";
import { handleUpdateConfig } from "../../src/extension/config/handle-update-config.js";

const noOverride = () => ({ workspace: false, folder: false });

describe("handleUpdateConfig", () => {
  it("writes a valid non-default key/value to global config", () => {
    const updateConfig = vi.fn(() => Promise.resolve());
    handleUpdateConfig("quoll.editor.fontFamily", "serif", {
      updateConfig,
      inspectOverride: noOverride,
      repush: vi.fn(),
      showInfo: vi.fn(),
    });
    expect(updateConfig).toHaveBeenCalledWith("quoll.editor.fontFamily", "serif");
  });

  it("writes undefined (reset) when the value IS the key default", () => {
    const updateConfig = vi.fn(() => Promise.resolve());
    handleUpdateConfig("quoll.editor.lineHeight", "cozy", {
      updateConfig,
      inspectOverride: noOverride,
      repush: vi.fn(),
      showInfo: vi.fn(),
    });
    expect(updateConfig).toHaveBeenCalledWith("quoll.editor.lineHeight", undefined);
  });

  it("drops an unknown key without writing", () => {
    const updateConfig = vi.fn(() => Promise.resolve());
    handleUpdateConfig("arbitrary.key", "serif", {
      updateConfig,
      inspectOverride: noOverride,
      repush: vi.fn(),
      showInfo: vi.fn(),
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("rejects a prototype key WITHOUT throwing", () => {
    const updateConfig = vi.fn(() => Promise.resolve());
    expect(() =>
      handleUpdateConfig("toString", "x", {
        updateConfig,
        inspectOverride: noOverride,
        repush: vi.fn(),
        showInfo: vi.fn(),
      })
    ).not.toThrow();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("drops a value not in the key's enum (incl. a valid id from the wrong key)", () => {
    const updateConfig = vi.fn(() => Promise.resolve());
    handleUpdateConfig("quoll.editor.fontFamily", "large", {
      updateConfig,
      inspectOverride: noOverride,
      repush: vi.fn(),
      showInfo: vi.fn(),
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it("does NOT write on a workspace override; toasts AND re-pushes so pending clears", () => {
    const updateConfig = vi.fn(() => Promise.resolve());
    const showInfo = vi.fn();
    const repush = vi.fn();
    handleUpdateConfig("quoll.editor.fontSize", "large", {
      updateConfig,
      inspectOverride: () => ({ workspace: true, folder: false }),
      repush,
      showInfo,
    });
    expect(updateConfig).not.toHaveBeenCalled();
    expect(showInfo).toHaveBeenCalledOnce();
    expect(repush).toHaveBeenCalledOnce(); // clears the popover's pending row now
  });

  it("on async reject: toasts the error AND re-pushes so pending clears", async () => {
    const updateConfig = vi.fn(() => Promise.reject(new Error("denied")));
    const showError = vi.fn();
    const repush = vi.fn();
    handleUpdateConfig("quoll.editor.fontSize", "large", {
      updateConfig,
      inspectOverride: noOverride,
      repush,
      showInfo: vi.fn(),
      showError,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(showError).toHaveBeenCalledOnce();
    expect(repush).toHaveBeenCalledOnce();
  });

  it("on inspectOverride throw: does NOT throw, toasts the error AND re-pushes", () => {
    const updateConfig = vi.fn(() => Promise.resolve());
    const showError = vi.fn();
    const repush = vi.fn();
    expect(() =>
      handleUpdateConfig("quoll.editor.fontSize", "large", {
        updateConfig,
        inspectOverride: () => {
          throw new Error("inspect boom");
        },
        repush,
        showInfo: vi.fn(),
        showError,
      })
    ).not.toThrow();
    expect(updateConfig).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledOnce();
    expect(repush).toHaveBeenCalledOnce();
  });

  it("on synchronous throw: toasts the error AND re-pushes so pending clears", () => {
    const updateConfig = vi.fn(() => {
      throw new Error("sync boom");
    });
    const showError = vi.fn();
    const repush = vi.fn();
    handleUpdateConfig("quoll.editor.fontSize", "large", {
      updateConfig,
      inspectOverride: noOverride,
      repush,
      showInfo: vi.fn(),
      showError,
    });
    expect(showError).toHaveBeenCalledOnce();
    expect(repush).toHaveBeenCalledOnce();
  });
});
