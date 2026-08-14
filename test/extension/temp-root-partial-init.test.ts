import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

// The rollback that reclaims a half-built root is the one branch whose whole
// job is "do not leak", in a module whose whole purpose is not leaking — so it
// gets a test even though the obvious route fails.
//
// `vi.spyOn(fs, "mkdirSync")` throws "Cannot redefine property": the node:fs
// namespace exposes non-configurable properties. `vi.mock` redefines nothing —
// it swaps the module-registry entry the module under test imports — so the
// path IS reachable. Own file, because the mock is file-scoped and would
// otherwise apply to every case in temp-root.test.ts.
const attempted: string[] = [];

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    default: real,
    mkdirSync: (...args: Parameters<typeof real.mkdirSync>) => {
      const target = String(args[0]);
      attempted.push(target);
      if (target.endsWith(`${path.sep}ud`)) {
        throw new Error("ENOSPC: synthetic");
      }
      return real.mkdirSync(...args);
    },
  };
});

const realFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const { createRunTempRoot } = await import("./temp-root");

describe("createRunTempRoot partial init", () => {
  it("reclaims the half-built root and rethrows the original cause", () => {
    // The rollback's own failure must never mask the diagnosable one.
    expect(() => createRunTempRoot()).toThrow(/ENOSPC: synthetic/);
    // Named exactly rather than diffed from a directory listing, so a parallel
    // run cannot flake this.
    const root = path.dirname(attempted[0]);
    expect(path.basename(root).startsWith("quoll-e2e-")).toBe(true);
    expect(realFs.existsSync(root)).toBe(false);
  });
});
