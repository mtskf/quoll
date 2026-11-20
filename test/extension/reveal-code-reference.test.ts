import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Uri } from "vscode";
import { codeReferenceFileExistsWithinRoot } from "../../src/extension/surface/reveal-code-reference.js";
import { makeUnitTempDir } from "./temp-root.js";

const uri = (fsPath: string, scheme = "file"): Uri => ({ fsPath, scheme }) as Uri;

describe("codeReferenceFileExistsWithinRoot", () => {
  let temp: ReturnType<typeof makeUnitTempDir>;
  let root: Uri;

  beforeAll(async () => {
    temp = makeUnitTempDir("code-reference");
    root = uri(path.join(temp.dir, "root"));
    const outside = path.join(temp.dir, "outside");
    const insideFile = path.join(root.fsPath, "file.ts");
    const outsideFile = path.join(outside, "secret.ts");
    await fs.mkdir(root.fsPath);
    await fs.mkdir(outside);
    await fs.writeFile(insideFile, "inside");
    await fs.writeFile(outsideFile, "outside");
    await fs.symlink(insideFile, path.join(root.fsPath, "linked-in.ts"), "file");
    await fs.symlink(outsideFile, path.join(root.fsPath, "linked-out.ts"), "file");
    await fs.symlink(outside, path.join(root.fsPath, "linked-dir"), "dir");
  });

  afterAll(() => {
    temp?.dispose();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["file.ts", "linked-in.ts"])("accepts %s inside the root", async (name) => {
    expect(await codeReferenceFileExistsWithinRoot(uri(path.join(root.fsPath, name)), root)).toBe(
      true
    );
  });

  it.each([
    "linked-out.ts",
    path.join("linked-dir", "secret.ts"),
  ])("warns and rejects %s outside the root", async (name) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const target = uri(path.join(root.fsPath, name));
    expect(await codeReferenceFileExistsWithinRoot(target, root)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      "[quoll] code-reference rejected: real path escapes workspace root",
      {
        target: target.fsPath,
        root: root.fsPath,
      }
    );
  });

  it("rejects a missing file quietly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const target = uri(path.join(root.fsPath, "missing.ts"));
    expect(await codeReferenceFileExistsWithinRoot(target, root)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a directory", async () => {
    expect(await codeReferenceFileExistsWithinRoot(root, root)).toBe(false);
  });

  it("rejects non-file targets and roots quietly", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const target = uri(path.join(root.fsPath, "file.ts"));
    expect(await codeReferenceFileExistsWithinRoot(uri(target.fsPath, "memfs"), root)).toBe(false);
    expect(await codeReferenceFileExistsWithinRoot(target, uri(root.fsPath, "memfs"))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
});
