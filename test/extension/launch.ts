// Spawns a real VS Code Electron host pinned to engines.vscode
// (1.94.0) and hands off to the Mocha runner. Pinning the engine
// avoids "the daily stable broke our suite" failure modes — when
// engines.vscode bumps in package.json, this constant bumps with it.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runTests } from "@vscode/test-electron";

const VS_CODE_VERSION = "1.94.0";

// Preflight: fixtures directory must exist before we spawn Electron.
// Mirrors test/extension/e2e/harness.ts FIXTURES_DIR (kept in sync
// manually — harness.ts cannot be imported here because it depends on
// `vscode` which only resolves inside the Electron host). Asserting
// once at the parent-process boundary lets us fail before VS Code
// starts; the previous module-load-time `existsSync` inside harness.ts
// ran on every test file's first require and crashed the Electron
// runner with no mocha context, which triaged as an activation bug.
function preflightFixturesDir(): void {
  // __dirname at runtime is `out/test-e2e/`. Resolve up to the repo
  // root then back into the source-controlled fixtures directory.
  const fixturesDir = path.resolve(__dirname, "../..", "test/extension/e2e/fixtures");
  if (!fs.existsSync(fixturesDir)) {
    console.error(
      `[e2e] FIXTURES_DIR misresolved: ${fixturesDir} — tsconfig outDir may have changed`
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  try {
    preflightFixturesDir();
    const extensionDevelopmentPath = path.resolve(__dirname, "../..");
    const extensionTestsPath = path.resolve(__dirname, "./e2e/index");

    // VS Code creates a unix-domain IPC socket under user-data-dir; on
    // macOS the socket path must fit in 103 chars. The repo path under
    // ~/Dev/... + worktree name routinely exceeds that, so we put the
    // user-data-dir in a short tmp path. mkdtemp guarantees a unique
    // dir per run so parallel CI shards don't collide.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "quoll-e2e-"));

    await runTests({
      version: VS_CODE_VERSION,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ["--disable-extensions", `--user-data-dir=${userDataDir}`],
    });
  } catch (err) {
    console.error("Failed to run E2E tests:", err);
    process.exit(1);
  }
}

void main();
