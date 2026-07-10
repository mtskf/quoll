import { describe, expect, it } from "vitest";
import { shouldCloseSourceTab } from "../../src/extension/surface-swap.js";

describe("shouldCloseSourceTab", () => {
  it("does not close when there is no source tab", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: false,
        wasDirty: false,
        saveSucceeded: false,
        stillDirtyAfterSave: false,
      })
    ).toBe(false);
  });

  it("closes a clean doc's source tab", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: true,
        wasDirty: false,
        saveSucceeded: false,
        stillDirtyAfterSave: false,
      })
    ).toBe(true);
  });

  it("closes when a dirty doc was saved clean", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: true,
        wasDirty: true,
        saveSucceeded: true,
        stillDirtyAfterSave: false,
      })
    ).toBe(true);
  });

  it("does NOT close when the save failed (avoids reverting the shared working copy)", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: true,
        wasDirty: true,
        saveSucceeded: false,
        stillDirtyAfterSave: true,
      })
    ).toBe(false);
  });

  it("does NOT close when the doc is still dirty after a 'successful' save", () => {
    expect(
      shouldCloseSourceTab({
        hasSourceTab: true,
        wasDirty: true,
        saveSucceeded: true,
        stillDirtyAfterSave: true,
      })
    ).toBe(false);
  });
});
