import { lstat } from "node:fs/promises";
import * as path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveRealContainment } from "../../src/extension/links/real-containment.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  lstat: vi.fn(),
}));

it("stops after one missing lookup of the filesystem root", async () => {
  const fsRoot = path.parse(path.resolve(".")).root;
  const target = path.join(fsRoot, "no-such-top", "a", "b.md");
  const mockedLstat = vi.mocked(lstat);
  let rootLookups = 0;
  mockedLstat.mockImplementation(async (entryPath) => {
    // Bound the walk even if the root stop is removed.
    if (entryPath === fsRoot) {
      rootLookups++;
    }
    const code = entryPath === fsRoot && rootLookups > 1 ? "EIO" : "ENOENT";
    throw Object.assign(new Error(code), { code });
  });

  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(await resolveRealContainment(target, fsRoot)).toBe("outside");
    expect
      .soft(warn)
      .toHaveBeenCalledWith("[quoll] realpath containment walk reached the filesystem root", {
        targetPath: target,
        rootPath: fsRoot,
      });
    expect
      .soft(mockedLstat.mock.calls.filter(([entryPath]) => entryPath === fsRoot))
      .toHaveLength(1);
  } finally {
    warn.mockRestore();
  }
});
