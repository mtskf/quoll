// Spawns a real VS Code Electron host pinned to engines.vscode
// (1.94.0) and hands off to the Mocha runner. Pinning the engine
// avoids "the daily stable broke our suite" failure modes — when
// engines.vscode bumps in package.json, this constant bumps with it.

import * as fs from "node:fs";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";
import { createRunTempRoot, RUN_TEMP_ROOT_ENV } from "./temp-root";

const VS_CODE_VERSION = "1.94.0";

// Preflight: fixtures directory must exist before we spawn Electron.
// Mirrors test/extension/e2e/harness.ts FIXTURES_DIR (kept in sync
// manually — harness.ts cannot be imported here because it depends on
// `vscode` which only resolves inside the Electron host). Asserting
// once at the parent-process boundary lets us fail before VS Code
// starts; the previous module-load-time `existsSync` inside harness.ts
// ran on every test file's first require and crashed the Electron
// runner with no mocha context, which triaged as an activation bug.
// Throws rather than process.exit()ing, and runs BEFORE the run root exists.
// Both halves matter: exit() would skip the reclaim in the finally, and a throw
// from after createRoot() escapes with no finally to reclaim either. The
// ordering is load-bearing, so it rides the LaunchDeps seam and is pinned by
// launch-wiring.test.ts rather than left to a comment.
function preflightFixturesDir(): void {
  // __dirname at runtime is `out/test-e2e/`. Resolve up to the repo
  // root then back into the source-controlled fixtures directory.
  const fixturesDir = path.resolve(__dirname, "../..", "test/extension/e2e/fixtures");
  if (!fs.existsSync(fixturesDir)) {
    throw new Error(
      `[e2e] FIXTURES_DIR misresolved: ${fixturesDir} — tsconfig outDir may have changed`
    );
  }
}

/** Injectable seam so the wiring below — which env key carries the root, which
 *  dir VS Code gets, and that dispose() runs on BOTH the pass and fail paths —
 *  is unit-testable without downloading and spawning Electron. */
export interface LaunchDeps {
  runTests: typeof runTests;
  createRoot: typeof createRunTempRoot;
  preflight: typeof preflightFixturesDir;
}

export async function runE2E(
  deps: LaunchDeps = { runTests, createRoot: createRunTempRoot, preflight: preflightFixturesDir }
): Promise<void> {
  deps.preflight();

  // VS Code creates a unix-domain IPC socket under user-data-dir; on
  // macOS the socket path must fit in 103 chars. The repo path under
  // ~/Dev/... + worktree name routinely exceeds that, so we put the
  // user-data-dir in a short tmp path. mkdtemp guarantees a unique
  // root per run so parallel CI shards don't collide.
  //
  // The root also parents every per-test workspace dir — the suites
  // allocate through temp-root's makeTempDir, which reads the root from
  // RUN_TEMP_ROOT_ENV below — so this one dispose() reclaims the run's
  // whole tmp footprint. Before it, every run stranded its user-data dir
  // plus one dir per temp-file test, forever (+53 dirs per run measured
  // 2026-08-14, 2 544 accumulated).
  const run = deps.createRoot();
  // Own SIGINT ourselves. @vscode/test-electron ends innerRunTests with
  // `if (exitRequested && process.listenerCount('SIGINT') === 0) process.exit(1)`
  // — so without a listener here, the FIRST Ctrl+C (graceful close, child exits
  // 0) hard-exits this process from inside the await and the finally below
  // never runs, stranding the whole root. Holding a listener keeps the exit on
  // our side; a second Ctrl+C still force-closes through the library's own
  // handler.
  //
  // Baseline rather than a bare count: "has the library taken over?" means "did
  // a listener appear after ours", which reads correctly in a bare `node` run
  // (0 → 1) and under any host that already listens.
  const sigintListenersBefore = process.listenerCount("SIGINT");
  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
    // Post-spawn, the library's ctrlc1 has appeared and does the graceful child
    // close, so we stay passive and reclaim in the finally. Pre-spawn — during
    // downloadAndUnzipVSCode, minutes on a cold cache — ctrlc1 does not exist
    // yet, and merely holding this listener suppresses Node's default
    // termination. Without this branch Ctrl+C would be a dead key for that
    // whole window.
    if (process.listenerCount("SIGINT") <= sigintListenersBefore + 1) {
      try {
        run.dispose();
      } catch (err) {
        console.error(`[e2e] failed to reclaim temp root ${run.root}:`, err);
      }
      process.exit(130); // 128 + SIGINT
    }
  };
  process.on("SIGINT", onSigint);
  // SIGTERM is deliberately NOT handled. The library exposes no child pid and
  // no graceful stop, so a handler could only reclaim the root while VS Code
  // may still be running — and a plain `kill` of this process alone leaves the
  // child alive to recreate user-data-dir under the path just removed, trading
  // one stranded root for a stranded root plus an orphaned editor. An aborted
  // run keeping its own single root is the accepted outcome.
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./e2e/index");

    await deps.runTests({
      version: VS_CODE_VERSION,
      extensionDevelopmentPath,
      extensionTestsPath,
      extensionTestsEnv: { [RUN_TEMP_ROOT_ENV]: run.root },
      launchArgs: ["--disable-extensions", `--user-data-dir=${run.userDataDir}`],
    });
  } catch (err) {
    console.error("Failed to run E2E tests:", err);
    // exitCode, not process.exit: exit() skips the finally below and would
    // strand the whole root on every failing run.
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    if (interrupted) {
      // An interrupted run is not a pass — without this it would exit 0.
      process.exitCode ??= 130; // 128 + SIGINT
    }
    try {
      run.dispose();
    } catch (err) {
      // Never silent — an unreclaimable root is the bug this owns.
      console.error(`[e2e] failed to reclaim temp root ${run.root}:`, err);
      process.exitCode = 1;
    }
  }
}

// `require.main === module` holds only under `node out/test-e2e/launch.js`, so
// the wiring test can import runE2E without spawning anything.
if (require.main === module) {
  void runE2E().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
