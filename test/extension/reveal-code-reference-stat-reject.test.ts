import { stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Uri } from "vscode";
import { codeReferenceFileExistsWithinRoot } from "../../src/extension/surface/reveal-code-reference.js";
import { makeUnitTempDir } from "./temp-root.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, stat: vi.fn(fs.stat) };
});

let temp: ReturnType<typeof makeUnitTempDir>;
let root: Uri;
let target: Uri;

beforeAll(async () => {
  temp = makeUnitTempDir("code-reference-stat");
  root = { scheme: "file", fsPath: temp.dir } as Uri;
  target = { scheme: "file", fsPath: path.join(temp.dir, "file.ts") } as Uri;
  await writeFile(target.fsPath, "inside");
});

afterAll(() => {
  temp?.dispose();
});

it.each([
  ["ENOENT", 0],
  ["EACCES", 1],
])("returns false when stat rejects with %s", async (code, warnings) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const mockedStat = vi.mocked(stat);
  try {
    mockedStat.mockRejectedValueOnce(Object.assign(new Error(code), { code }));

    await expect(codeReferenceFileExistsWithinRoot(target, root)).resolves.toBe(false);
    expect(mockedStat).toHaveBeenCalledWith(target.fsPath);
    expect(warn).toHaveBeenCalledTimes(warnings);
  } finally {
    mockedStat.mockReset();
    warn.mockRestore();
  }
});
