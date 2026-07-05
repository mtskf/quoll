#!/usr/bin/env node
// scripts/release.mjs
//
// Make the local pre-tag release steps mechanical and PRE-EMPT the
// publish workflow's fail-fast locally, before a bad tag is ever pushed.
//
// The canonical release path is .github/workflows/publish.yml: it fires on
// a pushed tag `v*`, and its FIRST gate refuses the publish if the tag
// version != package.json version. A mismatched tag therefore burns a CI
// run and leaves a dangling tag on origin that has to be deleted. This
// script removes that whole failure mode by DERIVING the tag name from
// package.json (never accepting a manual version arg), so tag==package.json
// holds by construction — the CI check can only ever pass.
//
// Subcommands:
//   check          Read-only preflight. Exit 0 if ready to release, else 1
//                  with an actionable message. Verifies the tag does not
//                  already exist and that CHANGELOG documents this version.
//   bump           Bump package.json patch version (x.y.z -> x.y.(z+1)) in
//                  place, preserving formatting. Does NOT touch CHANGELOG
//                  (release-note prose is human/Claude-authored).
//   tag [--push]   Run `check`, then create an annotated tag `v<version>`.
//                  Without --push: local only + prints the push command.
//                  With --push: pushes to origin (this triggers publish.yml
//                  — the real release).
//
// Zero new deps: Node built-ins + git only.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(repoRoot, "package.json");
const changelogPath = join(repoRoot, "CHANGELOG.md");

// --- helpers ---------------------------------------------------------------

/** Read package.json and return { version, raw }. */
function readPkg() {
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    fail(`package.json version is missing or not x.y.z (got: ${JSON.stringify(pkg.version)})`);
  }
  return { version: pkg.version, raw };
}

function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", ...opts });
}

/** True if the annotated/lightweight tag already exists in this clone. */
function localTagExists(tag) {
  const out = git(["tag", "--list", tag]).trim();
  return out.length > 0;
}

/**
 * Best-effort remote collision probe. Returns true / false, or null when the
 * remote is unreachable (offline, auth refusal). Non-fatal by design: origin
 * is reached over SSH and this machine's agent can intermittently refuse the
 * sign, so BatchMode + a short timeout keep `check` from ever hanging or
 * raising an approval prompt — a push would still fail fast on a real
 * collision, and publish.yml re-verifies the tag content.
 */
function remoteTagExists(tag) {
  try {
    const out = execFileSync("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5" },
    });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

/**
 * Assert CHANGELOG.md documents `version`.
 *
 * CHANGELOG uses ONE `## <major>.<minor>.x` heading with free-prose bullets
 * and NO structured per-patch version markers — and the prose legitimately
 * mentions older versions (e.g. "...stay on 0.1.7..."), so scanning for a
 * literal version token would false-positive/negative. The strictest check
 * the real format supports is therefore heading existence, with a warning
 * that a specific patch entry cannot be verified.
 *
 * Returns { ok, message?, warning? }.
 */
function checkChangelog(version) {
  const [maj, min] = version.split(".");
  const raw = readFileSync(changelogPath, "utf8");
  const headingRe = new RegExp(`^##\\s+${maj}\\.${min}\\.x(\\b|\\s|$)`, "m");
  if (!headingRe.test(raw)) {
    return {
      ok: false,
      message: `CHANGELOG.md has no "## ${maj}.${min}.x" section — add the release notes heading (and this patch's bullet) before tagging.`,
    };
  }
  return {
    ok: true,
    warning: `CHANGELOG.md "## ${maj}.${min}.x" section exists, but its bullets carry no per-patch version markers, so an entry for ${version} specifically cannot be verified — confirm the note is present by eye.`,
  };
}

function fail(msg) {
  console.error(`release: ${msg}`);
  process.exit(1);
}

// --- subcommands -----------------------------------------------------------

/** Read-only preflight. Returns true when ready to release. */
function runCheck() {
  const { version } = readPkg();
  const tag = `v${version}`;
  const problems = [];
  const warnings = [];

  if (localTagExists(tag)) {
    problems.push(`tag ${tag} already exists locally — bump the patch version first (node scripts/release.mjs bump).`);
  }
  const remote = remoteTagExists(tag);
  if (remote === true) {
    problems.push(`tag ${tag} already exists on origin — this version was already released; bump the patch version.`);
  } else if (remote === null) {
    warnings.push(`could not reach origin to check for a remote ${tag} (offline or SSH agent refusal) — a push would still fail fast on a real collision.`);
  }

  const cl = checkChangelog(version);
  if (!cl.ok) problems.push(cl.message);
  else if (cl.warning) warnings.push(cl.warning);

  for (const w of warnings) console.warn(`release check: warning: ${w}`);

  if (problems.length > 0) {
    console.error(`release check: NOT ready to release ${tag}:`);
    for (const p of problems) console.error(`  - ${p}`);
    return false;
  }
  console.log(`release check: ready to release ${tag}.`);
  return true;
}

/** Bump the patch version in place, preserving package.json formatting. */
function runBump() {
  const { version, raw } = readPkg();
  const [maj, min, patch] = version.split(".").map(Number);
  const next = `${maj}.${min}.${patch + 1}`;

  // Replace only the version field's value so indentation, key order, and the
  // trailing newline are untouched (JSON.stringify would risk reformatting).
  const re = /("version":\s*")(\d+\.\d+\.\d+)(")/;
  const match = raw.match(re);
  if (!match || match[2] !== version) {
    fail(`could not locate the "version": "${version}" field in package.json to bump.`);
  }
  const updated = raw.replace(re, `$1${next}$3`);
  writeFileSync(pkgPath, updated);
  console.log(`v${version} -> v${next}`);
}

/** Create the annotated tag; push it iff --push. */
function runTag(push) {
  if (!runCheck()) {
    console.error("release tag: refusing to tag — resolve the issues above first.");
    process.exit(1);
  }
  const { version } = readPkg();
  const tag = `v${version}`;

  git(["tag", "-a", tag, "-m", `Release ${tag}`], { stdio: "inherit" });

  if (push) {
    git(["push", "origin", tag], { stdio: "inherit" });
    console.log(`release tag: pushed ${tag} — publish.yml will now build and publish it.`);
  } else {
    console.log(`release tag: created local annotated tag ${tag}.`);
    console.log("To trigger the Marketplace + Open VSX release, run:");
    console.log(`  git push origin ${tag}`);
  }
}

// --- dispatch --------------------------------------------------------------

function usage() {
  console.error("usage: node scripts/release.mjs <check|bump|tag [--push]>");
}

const cmd = process.argv[2];
switch (cmd) {
  case "check":
    process.exit(runCheck() ? 0 : 1);
    break;
  case "bump":
    runBump();
    break;
  case "tag":
    runTag(process.argv.includes("--push"));
    break;
  default:
    usage();
    process.exit(2);
}
