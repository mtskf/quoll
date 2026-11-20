import { describe, expect, it } from "vitest";
import { isRealPathWithinRoot } from "../../src/extension/links/real-containment.js";

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
  it("accepts a file whose name starts with two dots", () => {
    expect(isRealPathWithinRoot("/ws/..notes.md", "/ws")).toBe(true);
  });
  it("rejects a file one directory above the root", () => {
    expect(isRealPathWithinRoot("/ws/x", "/ws/src")).toBe(false);
  });
  it("rejects a path that escapes the root", () => {
    expect(isRealPathWithinRoot("/outside/x", "/ws")).toBe(false);
  });
  it("rejects a sibling whose path shares the root's prefix", () => {
    expect(isRealPathWithinRoot("/ws-evil/x", "/ws")).toBe(false);
  });
});
