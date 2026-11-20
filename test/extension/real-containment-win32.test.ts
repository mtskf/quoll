import { describe, expect, it, vi } from "vitest";

// Run the module under win32 path semantics: on win32 `path.relative` compares
// case-insensitively, which NTFS per-directory case sensitivity makes unsafe.
vi.mock("node:path", async () => {
  const actual = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual.win32, default: actual.win32 };
});

import { isRealPathWithinRoot } from "../../src/extension/links/real-containment";

describe("isRealPathWithinRoot under win32 path semantics", () => {
  it("rejects a sibling that differs from the root only by case", () => {
    expect(isRealPathWithinRoot("C:\\work\\notes\\file.md", "C:\\work\\Notes")).toBe(false);
  });

  it("accepts a descendant with matching case", () => {
    expect(isRealPathWithinRoot("C:\\work\\Notes\\file.md", "C:\\work\\Notes")).toBe(true);
  });

  it("accepts the root itself", () => {
    expect(isRealPathWithinRoot("C:\\work\\Notes", "C:\\work\\Notes")).toBe(true);
  });
});
