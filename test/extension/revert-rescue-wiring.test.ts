import { describe, expect, it } from "vitest";

import { createRevertRescueWiring } from "../../src/extension/revert-rescue-wiring.js";

describe("createRevertRescueWiring", () => {
  it("exports a factory", () => {
    expect(typeof createRevertRescueWiring).toBe("function");
  });
});
