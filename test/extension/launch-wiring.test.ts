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

const noopPreflight = (): void => undefined;

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("runE2E wiring", () => {
  it("hands the run root to the host and the user-data dir to VS Code", async () => {
    const run = fakeRoot();
    const runTests = vi.fn().mockResolvedValue(0);
    await runE2E({ runTests, createRoot: () => run, preflight: noopPreflight });

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

    await runE2E({ runTests, createRoot: () => run, preflight: noopPreflight });

    expect(run.dispose).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it("fails the run loudly when the root cannot be reclaimed", async () => {
    const run = fakeRoot();
    run.dispose.mockImplementation(() => {
      throw new Error("EBUSY");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await runE2E({
      runTests: vi.fn().mockResolvedValue(0),
      createRoot: () => run,
      preflight: noopPreflight,
    });

    expect(process.exitCode).toBe(1);
    expect(errorSpy.mock.calls[0][0]).toContain("/t/r");
  });

  it("never creates a root it would have no finally to reclaim", async () => {
    // The preflight must run BEFORE createRoot: a throw from after it escapes
    // with no finally, stranding the root. Ordering, not just the throw.
    const createRoot = vi.fn();
    const preflight = vi.fn(() => {
      throw new Error("[e2e] FIXTURES_DIR misresolved");
    });
    await expect(runE2E({ runTests: vi.fn(), createRoot, preflight })).rejects.toThrow(
      /FIXTURES_DIR/
    );
    expect(createRoot).not.toHaveBeenCalled();
  });
});

describe("runE2E signal wiring", () => {
  it("stays passive while the library owns SIGINT, then reclaims and exits 130", async () => {
    // Post-spawn, @vscode/test-electron's ctrlc1 is also listening (simulated
    // here). We must NOT reclaim mid-run — the library is still gracefully
    // closing the child — but the run must not report a pass either.
    const run = fakeRoot();
    const before = process.listenerCount("SIGINT");
    const libraryHandler = (): void => undefined;
    let duringRun = 0;
    const runTests = vi.fn().mockImplementation(async () => {
      // ctrlc1 is registered inside innerRunTests, i.e. only once the child has
      // spawned — so it appears AFTER ours, which is what the baseline check
      // detects.
      process.on("SIGINT", libraryHandler);
      duringRun = process.listenerCount("SIGINT");
      process.emit("SIGINT");
      expect(run.dispose).not.toHaveBeenCalled(); // passive: the finally reclaims
      process.removeListener("SIGINT", libraryHandler);
      return 0;
    });

    await runE2E({ runTests, createRoot: () => run, preflight: noopPreflight });

    expect(duringRun).toBe(before + 2);
    expect(run.dispose).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("reclaims and exits itself when nothing else is listening (pre-spawn Ctrl+C)", async () => {
    // Before the child spawns there is no ctrlc1, and merely holding a listener
    // suppresses Node's default terminate — so Ctrl+C would otherwise do
    // nothing at all for the whole download window.
    const run = fakeRoot();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const runTests = vi.fn().mockImplementation(async () => {
      process.emit("SIGINT");
      return 0;
    });

    await runE2E({ runTests, createRoot: () => run, preflight: noopPreflight });

    expect(exit).toHaveBeenCalledWith(130);
    // Before the exit, not merely "at some point" — the finally would satisfy that.
    expect(run.dispose.mock.invocationCallOrder[0]).toBeLessThan(exit.mock.invocationCallOrder[0]);
  });

  it("does not downgrade a real failure to 130", async () => {
    const run = fakeRoot();
    const libraryHandler = (): void => undefined;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const runTests = vi.fn().mockImplementation(async () => {
      process.on("SIGINT", libraryHandler);
      process.emit("SIGINT");
      process.removeListener("SIGINT", libraryHandler);
      throw new Error("suite failed");
    });

    await runE2E({ runTests, createRoot: () => run, preflight: noopPreflight });

    expect(process.exitCode).toBe(1); // the `??=`, not `=`
  });

  it("leaves no signal listeners behind on the happy path", async () => {
    const before = process.listenerCount("SIGINT");
    await runE2E({
      runTests: vi.fn().mockResolvedValue(0),
      createRoot: fakeRoot,
      preflight: noopPreflight,
    });
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});
