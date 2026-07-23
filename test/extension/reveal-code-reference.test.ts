import { describe, expect, it } from "vitest";
import { isRealPathWithinRoot } from "../../src/extension/surface/reveal-code-reference.js";

describe("isRealPathWithinRoot", () => {
  it("accepts a file inside the root", () => {
    expect(isRealPathWithinRoot("/ws/src/foo.ts", "/ws")).toBe(true);
  });
  it("accepts the root itself", () => {
    expect(isRealPathWithinRoot("/ws", "/ws")).toBe(true);
  });
  it("accepts a deeply nested file", () => {
    expect(isRealPathWithinRoot("/ws/a/b/c/foo.ts", "/ws")).toBe(true);
  });
  it("rejects a path that escapes the root", () => {
    expect(isRealPathWithinRoot("/outside/x", "/ws")).toBe(false);
  });
  it("rejects a sibling whose path shares the root's prefix", () => {
    expect(isRealPathWithinRoot("/ws-evil/x", "/ws")).toBe(false);
  });
});
