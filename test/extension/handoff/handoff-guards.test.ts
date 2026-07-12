import { afterEach, describe, expect, it, vi } from "vitest";
import { makeHandoffGuards } from "../../../src/extension/handoff/handoff-guards.js";

afterEach(() => vi.restoreAllMocks());

describe("makeHandoffGuards", () => {
  it("tryBool returns true only for a resolved true", async () => {
    const { tryBool } = makeHandoffGuards("context-handoff");
    expect(await tryBool(async () => true, "op")).toBe(true);
    expect(await tryBool(async () => false, "op")).toBe(false);
  });
  it("tryBool swallows rejections, logs with the bound context, returns false", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tryBool } = makeHandoffGuards("codex-context-handoff");
    expect(
      await tryBool(async () => {
        throw new Error("x");
      }, "reveal")
    ).toBe(false);
    expect(err).toHaveBeenCalledWith(
      "[quoll] codex-context-handoff: reveal failed",
      expect.any(Error)
    );
  });
  it("tryShow swallows rejections and logs the bound context", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { tryShow } = makeHandoffGuards("context-handoff");
    await tryShow(async () => {
      throw new Error("x");
    }, "msg");
    expect(err).toHaveBeenCalledWith(
      "[quoll] context-handoff: message surface rejected",
      expect.any(Error)
    );
  });
});
