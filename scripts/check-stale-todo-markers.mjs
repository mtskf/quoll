#!/usr/bin/env node
// scripts/check-stale-todo-markers.mjs
//
// Catch stale in-flight (🚧) markers in the TODO file.
//
// Why this exists: active work in .claude/docs/TODO.md is marked
//   `- [ ] ... 🚧 ... (branch: X)`. /merge-pr's post-merge sync removes that
// marker when the PR lands, moving the entry into TODO-archive.md. But a merge
// done via the GitHub web UI or `gh pr merge` bypasses /merge-pr, so the 🚧
// marker survives — and /next-todo then proposes work that already shipped.
// This script is the backstop: it asks GitHub whether each 🚧 entry's PR is
// already MERGED and fails (exit 1) if so, surfacing the stale marker.
//
// Design notes:
//  - No new dependencies: it shells out to the `gh` CLI (already a dev tool)
//    via execFileSync (argv array, no shell — no injection surface).
//  - Fail-soft locally: if gh is missing or unauthenticated it warns and
//    exits 0, so a contributor without gh isn't blocked. CI provides
//    GH_TOKEN, so the guard is authoritative there.
//
// Usage:
//   node scripts/check-stale-todo-markers.mjs [path-to-todo.md]
// Default path: .claude/docs/TODO.md

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DEFAULT_TODO = ".claude/docs/TODO.md";
const todoPath = process.argv[2] ?? DEFAULT_TODO;

let text;
try {
  text = readFileSync(todoPath, "utf8");
} catch (err) {
  console.error(`check-stale-todo-markers: cannot read ${todoPath}: ${err.message}`);
  process.exit(2);
}

// An ACTIVE in-flight entry is an unchecked task line carrying the 🚧 glyph.
// Checked (`- [x]`) lines are done and never in-flight, so they are skipped.
const inflight = text
  .split("\n")
  .filter((line) => /^\s*-\s*\[ \]/.test(line) && line.includes("🚧"));

if (inflight.length === 0) {
  console.log("check-stale-todo-markers: no 🚧 in-flight entries — OK");
  process.exit(0);
}

// Extract the branch and/or PR number from one entry line. Both the modern
// `(branch: X)` form and the legacy `<!-- branch: X -->` HTML marker are
// recognized (the same two forms /merge-pr's sync understands). PR numbers
// appear as `(PR #123)` or a bare `(#123)`.
function parseEntry(line) {
  const branch =
    line.match(/\(branch:\s*([^)]+?)\s*\)/)?.[1] ??
    line.match(/<!--\s*branch:\s*(.+?)\s*-->/)?.[1] ??
    null;
  const pr =
    line.match(/\(PR #(\d+)\)/)?.[1] ?? line.match(/\(#(\d+)\)/)?.[1] ?? null;
  // A short label for the report: the first **bold** title, else a slice.
  const title = line.match(/\*\*(.+?)\*\*/)?.[1] ?? line.slice(0, 80).trim();
  return { branch, pr, title };
}

// Run gh and return parsed JSON, or null if gh is unavailable/unauthenticated
// so the caller can decide to warn-and-pass rather than hard-fail.
function gh(args) {
  try {
    const out = execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out);
  } catch (err) {
    const msg = `${err.stderr ?? ""}${err.message ?? ""}`;
    if (
      err.code === "ENOENT" || // gh not installed
      /not logged|authentication|gh auth login|GH_TOKEN/i.test(msg)
    ) {
      throw new GhUnavailable(msg.trim());
    }
    // Other failures (e.g. transient API error) — treat as unavailable too,
    // since a guard that hard-fails on a flaky network would be worse than
    // one that warns. CI re-runs catch genuinely stale markers.
    throw new GhUnavailable(msg.trim() || String(err));
  }
}

class GhUnavailable extends Error {}

// Resolve whether an entry's PR has already merged. Prefer the branch lookup
// (covers entries with only a branch); fall back to the PR number.
function resolveMerged({ branch, pr }) {
  if (branch) {
    const prs = gh([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,title,mergedAt",
      "--limit",
      "5",
    ]);
    const merged = prs.find((p) => p.state === "MERGED");
    if (merged) return { number: merged.number, title: merged.title };
    return null;
  }
  if (pr) {
    const view = gh(["pr", "view", pr, "--json", "state,title,mergedAt"]);
    if (view.state === "MERGED") return { number: Number(pr), title: view.title };
    return null;
  }
  return null;
}

const stale = [];
try {
  for (const line of inflight) {
    const entry = parseEntry(line);
    if (!entry.branch && !entry.pr) continue; // nothing to resolve against
    const merged = resolveMerged(entry);
    if (merged) stale.push({ entry, merged });
  }
} catch (err) {
  if (err instanceof GhUnavailable) {
    console.warn(
      `check-stale-todo-markers: gh unavailable/unauthenticated — skipping check.\n  (${err.message})`,
    );
    process.exit(0);
  }
  throw err;
}

if (stale.length === 0) {
  console.log(
    `check-stale-todo-markers: ${inflight.length} 🚧 in-flight ${
      inflight.length === 1 ? "entry" : "entries"
    } checked, none stale — OK`,
  );
  process.exit(0);
}

console.error(`check-stale-todo-markers: ${stale.length} STALE 🚧 marker(s) in ${todoPath}\n`);
for (const { entry, merged } of stale) {
  const branch = entry.branch ? `branch: ${entry.branch}` : `PR #${merged.number}`;
  console.error(`  ✗ ${entry.title}`);
  console.error(`      ${branch} — PR #${merged.number} is MERGED: ${merged.title}`);
}
console.error(
  "\nRemediation: the PR(s) above merged outside /merge-pr, so the 🚧 entry was\n" +
    "never archived. Move each stale entry from the TODO file into TODO-archive.md\n" +
    "(collapse to a one-line ✅ entry), then re-run this check. Going forward, merge\n" +
    "through /merge-pr so its post-merge sync handles this automatically.",
);
process.exit(1);
