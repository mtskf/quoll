// Build helper for the E2E suite.
//
// Why a script (and not just `tsc -p && node launch.js`):
//   - The repo's package.json declares "type": "module", so Node
//     loads every `.js` it sees as ESM. tsc emits CommonJS for the
//     E2E tree (target Node 20, Mocha's runner is CJS-shaped).
//     Without a sibling package.json marking `out/test-e2e/` as
//     "commonjs", Node would try to ESM-load the emitted .js files
//     and crash with ERR_REQUIRE_ESM or syntax errors on `module.exports`.
//   - Writing the package.json after tsc keeps it from being clobbered
//     by an `outDir` reset.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const outDir = resolve(repoRoot, "out/test-e2e");

// Clean the out tree so a renamed or deleted *.test.ts from an earlier
// run does not survive as a stale *.test.js — index.ts's readdirSync
// would still pick it up and run an orphan test against current sources.
rmSync(outDir, { recursive: true, force: true });

// Run tsc via the local binary (no global dependency).
execFileSync("pnpm", ["exec", "tsc", "-p", "test/extension"], {
  cwd: repoRoot,
  stdio: "inherit",
});

mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "package.json"),
  JSON.stringify({ type: "commonjs" }, null, 2) + "\n"
);

console.log("[test:e2e] built out/test-e2e/ (CJS marker written)");
