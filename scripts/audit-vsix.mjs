#!/usr/bin/env node
// scripts/audit-vsix.mjs
//
// Audit a packaged .vsix against an allowlist. Exits 1 if any shipped
// file falls outside the allowlist — defends against .vscodeignore
// regressions that would leak internal files (docs/, .github/, .claude/,
// raw *.ts, *.map, lockfiles, .env*, coverage data, test fixtures) into
// the Marketplace bundle.
//
// Why allowlist (not denylist): file growth at the repo root is
// unbounded; the shippable set is small and stable. A denylist forgets
// to ignore each new dotfile or generated artifact; an allowlist holds
// the line by default. Mirrors .vscodeignore's allowlist shape.
//
// Usage: node scripts/audit-vsix.mjs <path-to-vsix>

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const vsixPath = process.argv[2];
if (!vsixPath) {
  console.error("usage: node scripts/audit-vsix.mjs <path-to-vsix>");
  process.exit(2);
}
if (!existsSync(vsixPath)) {
  console.error(`audit-vsix: ${vsixPath} not found`);
  process.exit(2);
}

// vsix is a zip. `unzip -Z1` emits one path per line. Directory
// entries appear as "path/" and are ignored — we only audit files.
let raw;
try {
  raw = execFileSync("unzip", ["-Z1", vsixPath], { encoding: "utf8" });
} catch (err) {
  // maxBuffer exceeded surfaces as err.code === "ENOBUFS". For unzip the
  // status/signal shape is { status: <exit-code>, signal: null }: spawnSync
  // closes the pipe when the buffer fills, unzip exits early on the broken
  // pipe, and Node reports ENOBUFS alongside the child's exit code. Branch
  // on the code so the spawn/exit classifier below doesn't mislabel this
  // as a corrupt archive — the .vsix is fine, the output just didn't fit.
  if (err.code === "ENOBUFS") {
    console.error(
      `audit-vsix: \`unzip -Z1\` output exceeded Node's default buffer limit for ${vsixPath}.`
    );
    console.error(
      "The .vsix itself is likely fine — re-run with a larger maxBuffer or inspect the archive manually."
    );
    process.exit(2);
  }
  // Distinguish spawn-level failures (process never started — install or
  // permission issues with actionable fixes) from unzip-level failures
  // (process ran but exited non-zero — usually a corrupt .vsix).
  // execFileSync sets err.status to the numeric exit code only when the
  // child actually ran. On spawn failure the field is null *or* undefined
  // depending on Node version, so `== null` (not `===`) is intentional —
  // it catches both without a separate undefined check.
  const spawnFailed = err.status == null && err.signal == null;
  if (spawnFailed) {
    if (err.code === "ENOENT") {
      console.error(
        "audit-vsix: `unzip` not found on PATH. Install via `apt-get install unzip` / `brew install unzip`."
      );
    } else if (err.code === "EACCES") {
      console.error(
        "audit-vsix: `unzip` on PATH is not executable (EACCES). Check file permissions."
      );
    } else {
      console.error(
        `audit-vsix: failed to spawn \`unzip\` (${err.code ?? "unknown error"}): ${err.message}`
      );
    }
    process.exit(2);
  }
  // Info-ZIP's `unzip -Z1` exits 1 with stdout "Empty zipfile." for a
  // structurally valid archive that contains zero entries (EOCD only).
  // Surface that as the root cause — otherwise the generic "corrupt"
  // branch below would misdirect the operator.
  if (err.status === 1 && typeof err.stdout === "string" && err.stdout.includes("Empty zipfile")) {
    console.error(`audit-vsix: ${vsixPath} contains no files (empty or truncated archive)`);
    process.exit(1);
  }
  const exitDesc = err.signal ? `killed by signal ${err.signal}` : `exit ${err.status}`;
  console.error(`audit-vsix: \`unzip\` failed to inspect ${vsixPath} (${exitDesc}):`);
  if (err.stderr) {
    console.error(err.stderr.toString().trimEnd());
  }
  console.error("The .vsix may be corrupt or not a valid zip archive.");
  process.exit(2);
}
const entries = raw.split("\n").filter((e) => e.length > 0 && !e.endsWith("/"));

// Belt-and-suspenders for any unzip variant that exits 0 on an empty
// archive (Info-ZIP exits 1 — handled in the catch above). Reports the
// root cause instead of letting REQUIRED_PAYLOAD surface every entry
// as "missing".
if (entries.length === 0) {
  console.error(`audit-vsix: ${vsixPath} contains no files (empty or truncated archive)`);
  process.exit(1);
}

// vsce always emits these two at the archive root — bundle envelope,
// not user content. Always allowed.
const ALLOWED_ROOT = new Set(["extension.vsixmanifest", "[Content_Types].xml"]);

// Payload allowlist (paths relative to "extension/"). Mirrors
// .vscodeignore. vsce applies two filename normalisations the
// allowlist must absorb:
//   1. Lowercases README.md → readme.md and CHANGELOG.md →
//      changelog.md (the /i flag on those regexes covers this).
//   2. Appends .txt to extensionless LICENSE → LICENSE.txt
//      (the optional (\.txt)? group covers this; LICENSE itself
//      stays uppercase, so /i is defensive, not load-bearing).
const ALLOWED_PAYLOAD = [
  /^package\.json$/i,
  /^icon\.png$/i,
  /^readme\.md$/i,
  /^license(\.txt)?$/i,
  /^changelog\.md$/i,
  /^dist\/[\w./-]+\.(cjs|js|css|json)$/,
];

// Required runtime files. vsce enforces package.json#main exists, but
// the webview assets are only referenced from source — the host builds
// the HTML per resolveCustomTextEditor call via
// src/extension/webview-html.ts (asset URIs come from webview-assets.ts).
// A .vscodeignore regression that drops dist/webview/** would produce a
// broken editor that the allowlist alone would let through silently.
const REQUIRED_PAYLOAD = [
  "dist/extension.cjs",
  "dist/webview/index.js",
  "dist/webview/index.css",
  "dist/package.json",
];

const payloadSet = new Set();
const violations = [];

for (const entry of entries) {
  if (ALLOWED_ROOT.has(entry)) {
    continue;
  }
  if (!entry.startsWith("extension/")) {
    violations.push(`${entry} (unexpected file outside extension/ payload)`);
    continue;
  }
  const payload = entry.slice("extension/".length);
  payloadSet.add(payload);
  if (!ALLOWED_PAYLOAD.some((re) => re.test(payload))) {
    violations.push(entry);
  }
}

const missing = REQUIRED_PAYLOAD.filter((r) => !payloadSet.has(r));

// Report both diagnostics in a single run so CI doesn't have to be
// re-run after fixing only one half. Recovery hints are per-case
// because the likely cause differs:
//   - Missing files: the dist/ bundle was never built (or the build
//     failed before this script ran). .vscodeignore over-exclusion is
//     rare — the allowlist re-includes `dist/**` wholesale.
//   - Violations: .vscodeignore under-excluded a new path, or the
//     build leaked a new file type. Allowlist extension is the escape
//     hatch when the new file is intentional.
if (missing.length > 0 || violations.length > 0) {
  if (missing.length > 0) {
    console.error(`audit-vsix: required files missing from ${vsixPath}:`);
    for (const m of missing) {
      console.error(`  extension/${m}`);
    }
    console.error("");
    console.error(
      "Re-run `pnpm build && pnpm package` — most regressions here are stale or skipped builds. If files are still missing afterwards, check `.vscodeignore` did not over-exclude `dist/`."
    );
    console.error("");
  }
  if (violations.length > 0) {
    console.error(`audit-vsix: disallowed files in ${vsixPath}:`);
    for (const v of violations) {
      console.error(`  ${v}`);
    }
    console.error("");
    console.error(
      "Check `.vscodeignore` for a missing exclusion (most regressions are mis-ignored paths) and re-run `pnpm build && pnpm package`."
    );
    console.error(
      "If a disallowed file is intentional, extend the allowlist in scripts/audit-vsix.mjs instead."
    );
  }
  process.exit(1);
}

console.log(`audit-vsix: ${entries.length} entries inspected in ${vsixPath}, no violations.`);
