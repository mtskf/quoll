import { afterEach, describe, expect, it, vi } from "vitest";
import { runE2E } from "./launch";
import type { RunTempRoot } from "./temp-root";

// The reclaim this PR exists for lives in launch.ts's wiring, not in the seam:
// which env key carries the root, which dir VS Code is given, and that
// dispose() runs on BOTH the pass and the fail path. Restoring `process.exit(1)`
// in the catch (the conventional CLI idiom) would keep every other suite green
// while silently skipping the finally — so pin it here.
const fakeRoot = (): RunTempRoot & { dispose: ReturnType<typeof vi.fn> } => ({
  root: "/t/r",
  userDataDir: "/t/r/ud",
  workDir: "/t/r/w",
  dispose: vi.fn(),
});

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("runE2E wiring", () => {
  it("hands the run root to the host and the user-data dir to VS Code", async () => {
    const run = fakeRoot();
    const runTests = vi.fn().mockResolvedValue(0);
    await runE2E({ runTests, createRoot: () => run });

    const opts = runTests.mock.calls[0][0];
    expect(opts.extensionTestsEnv).toEqual({ QUOLL_E2E_TEMP_ROOT: "/t/r" });
    expect(opts.launchArgs).toContain("--user-data-dir=/t/r/ud");
    expect(run.dispose).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("still reclaims the root when the suite fails", async () => {
    const run = fakeRoot();
    const runTests = vi.fn().mockRejectedValue(new Error("suite failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runE2E({ runTests, createRoot: () => run });

    expect(run.dispose).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("fails the run loudly when the root cannot be reclaimed", async () => {
    const run = fakeRoot();
    run.dispose.mockImplementation(() => {
      throw new Error("EBUSY");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runE2E({ runTests: vi.fn().mockResolvedValue(0), createRoot: () => run });

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls[0][0]).toContain("/t/r");
  });
});
