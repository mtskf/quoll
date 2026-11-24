#!/usr/bin/env node
// scripts/check-test-reach.mjs
//
// Fail when a test file on disk is reached by no test runner.
//
// Why this lives outside test/: a test cannot observe its own non-execution.
// One added line in vitest.config.ts's `exclude` (e.g. "test/build/**") drops
// every guard in that directory while the full run stays green, and no guard
// inside the dropped directory can report it. So this check asks the runners
// themselves which files they would run, and runs as its own CI step.
//
// The contract: every `test/**/*.test.ts` on disk is collected by at least one of
//   - unit:    the `test:unit` script, listed via `vitest list`
//   - browser: the `test:browser` script, listed via `vitest list`
//   - e2e:     test/extension/e2e/*.test.ts. test/extension/e2e/index.ts runs
//              every .test.js tsc emits into its directory, so no vitest config
//              can drop one. A file dropped from test/extension/tsconfig.json's
//              include is not caught here: test/build/no-file-level-ts-nocheck.test.ts
//              catches it (every test file must sit in some tsc program), and
//              this check keeps that guard itself in reach.
// Each runner's list comes from the package.json script CI actually calls, with
// `run` swapped for `list`, so a filter added to the script narrows the list too.
//
// Why compare against the files on disk, not a count or a roster of suites: a
// pinned number gets "fixed" by editing the number, and a roster goes stale as
// suites are added. The disk is the roster. An intentional exclusion therefore
// has to be spelled out here, in review, rather than slipped into a config.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { relative, sep } from "node:path";

const root = process.cwd();
const toRel = (file) => relative(root, file).split(sep).join("/");

function listScript(name) {
  const script = JSON.parse(readFileSync("package.json", "utf8")).scripts?.[name];
  const [bin, verb, ...rest] = script?.split(/\s+/) ?? [];
  if (bin !== "vitest" || verb !== "run") {
    throw new Error(`package.json "${name}" is ${JSON.stringify(script)}; expected "vitest run …"`);
  }
  const out = execFileSync("pnpm", ["exec", "vitest", "list", ...rest, "--filesOnly", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  // The browser config's build plugin logs to stdout before the JSON array.
  const files = JSON.parse(out.slice(out.indexOf("\n[") + 1)).map((entry) => toRel(entry.file));
  if (files.length === 0) {
    throw new Error(`"${name}" collected no test files`);
  }
  return files;
}

const onDisk = readdirSync("test", { recursive: true })
  .map((file) => `test/${file.split(sep).join("/")}`)
  .filter((file) => file.endsWith(".test.ts") && !file.includes("/node_modules/"));

const e2e = readdirSync("test/extension/e2e")
  .filter((file) => file.endsWith(".test.ts"))
  .map((file) => `test/extension/e2e/${file}`);

const reached = new Set([...listScript("test:unit"), ...listScript("test:browser"), ...e2e]);
const unreached = onDisk.filter((file) => !reached.has(file)).sort();

if (unreached.length > 0) {
  console.error(`✗ ${unreached.length} test file(s) on disk are run by no test runner:`);
  for (const file of unreached) {
    console.error(`  ${file}`);
  }
  console.error(
    "Check the include/exclude in vitest*.config.ts and the test:* scripts in package.json."
  );
  process.exit(1);
}
console.log(`✓ all ${onDisk.length} test files are reached by a runner`);
