import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isRealPathWithinRoot, resolveRealContainment } from "../../src/extension/links/real-containment.js";
import { makeUnitTempDir } from "./temp-root.js";

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

describe("resolveRealContainment", () => {
  let temp: ReturnType<typeof makeUnitTempDir>;
  let root: string;

  beforeAll(async () => {
    temp = makeUnitTempDir("real-containment");
    root = path.join(temp.dir, "root");
    const outside = path.join(temp.dir, "outside");
    const insideFile = path.join(root, "file.md");
    const outsideFile = path.join(outside, "file.md");
    await fs.mkdir(root);
    await fs.mkdir(outside);
    await fs.writeFile(insideFile, "inside");
    await fs.writeFile(outsideFile, "outside");
    await fs.symlink(outsideFile, path.join(root, "linked-out.md"), "file");
    await fs.symlink(outside, path.join(root, "linked-dir"), "dir");
    await fs.symlink(path.join(root, "absent.md"), path.join(root, "dangling.md"), "file");
    await fs.symlink(insideFile, path.join(root, "linked-in.md"), "file");
  });

  afterAll(() => {
    temp?.dispose();
  });

  it.each([
    ["regular file", ["file.md"], "inside"],
    ["file symlink outside the root", ["linked-out.md"], "outside"],
    ["file under a directory symlink outside the root", ["linked-dir", "file.md"], "outside"],
    ["dangling symlink", ["dangling.md"], "outside"],
    ["symlink inside the root", ["linked-in.md"], "inside"],
  ])("checks containment for a %s", async (_label, segments, verdict) => {
    expect(await resolveRealContainment(path.join(root, ...segments), root)).toBe(verdict);
  });

  it("warns and returns outside when the root is missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const missingRoot = path.join(temp.dir, "missing-root");
      expect(await resolveRealContainment(path.join(root, "file.md"), missingRoot)).toBe("outside");
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
