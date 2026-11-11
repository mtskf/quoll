import { describe, expect, it, vi } from "vitest";
import { postSwitchAborted } from "../../../src/extension/session/quoll-editor-panel.js";

describe("switch-aborted delivery", () => {
  it.each([
    "false",
    "reject",
    "throw",
  ])("warns a surviving panel when delivery fails: %s", async (failure) => {
    const showError = vi.fn();
    const send = vi.fn(() => {
      if (failure === "throw") {
        throw new Error("detached");
      }
      return failure === "reject" ? Promise.reject(new Error("detached")) : Promise.resolve(false);
    });
    await postSwitchAborted(send, () => false, showError);
    expect(showError).toHaveBeenCalledWith(expect.stringMatching(/reload.*window/i));
  });

  it("does not warn after disposal or successful delivery", async () => {
    const showError = vi.fn();
    await postSwitchAborted(
      () => Promise.resolve(false),
      () => true,
      showError
    );
    await postSwitchAborted(
      () => Promise.resolve(true),
      () => false,
      showError
    );
    let disposed = false;
    await postSwitchAborted(
      () => {
        disposed = true;
        return Promise.reject(new Error("disposed"));
      },
      () => disposed,
      showError
    );
    expect(showError).not.toHaveBeenCalled();
  });
});
