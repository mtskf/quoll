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
//  - Fail-soft & advisory: this is a LOCAL-only check (the TODO file lives
//    under .claude/, gitignored, absent from CI checkouts), so it never hard-
//    blocks a contributor. A missing/unauthenticated/rate-limited `gh` warns
//    and exits 0.
//  - The pure / dependency-injected exports (`parseEntry`, `resolveEntry`,
//    `scanTodo`, `summarize`, `runScan`, `classifyGhError`) are unit-tested
//    with in-memory fixtures and a fake `ghRunner`; `main()` is a thin fs +
//    console + process.exit wrapper behind the import-guard at the bottom.
//
// Verdict correctness (three false-verdict paths this file deliberately avoids):
//  (a) REUSED head-branch name — a branch name may be reused after its first
//      PR merged. `resolveEntry` prefers an OPEN PR for the branch, so still-
//      in-flight work is never flagged stale by an older same-named merged PR.
//  (b) NUMBER-ONLY match — PR numbers are reused across repo generations, so a
//      match resting solely on a `(#N)` / `(PR #N)` number is REPORT-ONLY
//      (a warning), never a hard STALE verdict. A conforming in-flight entry
//      names a `(branch: X)` (the marker `check-todo-hygiene.mjs` lints for)
//      and resolves via the branch path, which still exits 1 when stale.
//  (c) TRANSIENT gh failure — a one-off 404 / network blip skips only THAT
//      entry (recorded for a partial-scan warning) and keeps scanning; it does
//      NOT bail the whole loop. See the error taxonomy below.
//
// Error taxonomy (see `classifyGhError`):
//  - GhUnavailable — `gh` is unusable for the REST of this run: not installed
//    (ENOENT), not authenticated, or rate-limited. All three persist for the
//    run, so re-trying every remaining entry is futile; the scan stops but
//    still RETURNS what it already found (a stale marker confirmed before a
//    mid-scan auth expiry must not be silently discarded).
//  - GhTransient — a genuinely per-entry failure (single 404, one-off network
//    blip, unparseable JSON): skip that entry, continue.
//  Any OTHER error is a real bug and propagates (never swallowed), surfacing as
//  exit 2 — kept distinct from the stale exit 1 so a crash can't read as
//  "stale found".
//
// Exit codes: 0 = clean or partial scan (fail-soft), 1 = a genuine stale
// marker, 2 = TODO unreadable or an internal error.
//
// Usage:
//   node scripts/check-stale-todo-markers.mjs [path-to-todo.md]
// Default path: .claude/docs/TODO.md

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const DEFAULT_TODO = ".claude/docs/TODO.md";

// `gh` is unusable for the rest of this run (ENOENT / auth / rate limit).
export class GhUnavailable extends Error {}
// A single-entry `gh` failure (one 404, a network blip, unparseable JSON).
export class GhTransient extends Error {}

// Map a raw execFile/JSON error to the taxonomy. Pure — fake error objects in,
// the right class out — so the classification is unit-testable without a real
// `gh`. ENOENT (not installed), auth failures, and rate limits all persist for
// the run → GhUnavailable; everything else is treated as per-entry transient.
export function classifyGhError(err) {
  const msg = `${err?.stderr ?? ""}${err?.message ?? ""}`;
  if (
    err?.code === "ENOENT" ||
    /not logged|authentication|gh auth login|GH_TOKEN|rate limit/i.test(msg)
  ) {
    return new GhUnavailable(msg.trim() || String(err));
  }
  return new GhTransient(msg.trim() || String(err));
}

// Run `gh` and return parsed JSON. `exec` is injectable so tests can exercise
// the JSON.parse → GhTransient path and the happy path without a real binary.
// Throws GhUnavailable / GhTransient per classifyGhError; a JSON parse failure
// is transient (one bad response for one entry).
export function ghExec(args, exec = execFileSync) {
  let out;
  try {
    out = exec("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    throw classifyGhError(err);
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new GhTransient(`unparseable gh output: ${err.message}`);
  }
}

// An ACTIVE in-flight entry is an unchecked task line carrying the 🚧 glyph.
// Checked (`- [x]`) lines are done and never in-flight, so they are skipped.
export function parseInflight(text) {
  return text.split("\n").filter((line) => /^\s*-\s*\[ \]/.test(line) && line.includes("🚧"));
}

// Extract the branch and/or PR number from one entry line. Both the modern
// `(branch: X)` form and the legacy `<!-- branch: X -->` HTML marker are
// recognized (the same two forms /merge-pr's sync understands). PR numbers
// appear as `(PR #123)` or a bare `(#123)`.
export function parseEntry(line) {
  const branch =
    line.match(/\(branch:\s*([^)]+?)\s*\)/)?.[1] ??
    line.match(/<!--\s*branch:\s*(.+?)\s*-->/)?.[1] ??
    null;
  const pr = line.match(/\(PR #(\d+)\)/)?.[1] ?? line.match(/\(#(\d+)\)/)?.[1] ?? null;
  // A short label for the report: the first **bold** title, else a slice.
  const title = line.match(/\*\*(.+?)\*\*/)?.[1] ?? line.slice(0, 80).trim();
  return { branch, pr, title };
}

// Resolve one entry against GitHub via the injected `ghRunner`.
// Returns { status: "clean" | "stale" | "warn", merged?: { number, title } }.
//  - branch path (authoritative): fix (a) — an OPEN PR for the head branch
//    means the work is in flight, so it is NEVER stale, even if an OLDER
//    same-named PR merged. Only "no OPEN + a MERGED" → stale.
//  - number-only path: fix (b) — a match resting solely on a PR number is a
//    WARNING, never stale (PR numbers are reused across repo generations).
export function resolveEntry({ branch, pr }, ghRunner) {
  if (branch) {
    // fix (a): an OPEN PR for the head branch means the work is in flight, so
    // the entry is NEVER stale — even if an older same-named PR merged. Query
    // OPEN on its own (not a truncated `--state all` slice) so a busy reused
    // branch can't hide the in-flight PR behind a result cap.
    const open = ghRunner([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1",
    ]);
    if (open.length > 0) {
      return { status: "clean" }; // in flight — never stale (fix (a))
    }
    const merged = ghRunner([
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      "number,title,mergedAt",
      "--limit",
      "1",
    ]);
    if (merged.length > 0) {
      return { status: "stale", merged: { number: merged[0].number, title: merged[0].title } };
    }
    return { status: "clean" };
  }
  if (pr) {
    const view = ghRunner(["pr", "view", pr, "--json", "state,title,mergedAt"]);
    if (view.state === "MERGED") {
      // Report-only: a number can collide across repo generations (fix (b)).
      return { status: "warn", merged: { number: Number(pr), title: view.title } };
    }
    return { status: "clean" };
  }
  return { status: "clean" };
}

// Walk every in-flight entry, resolving each against `ghRunner`.
// Returns { inflightCount, stale, warnings, skipped, aborted }.
//  - GhTransient → record in `skipped`, keep scanning (fix (c)).
//  - GhUnavailable → record `aborted` and STOP, but still return everything
//    found so far (never discard a stale marker confirmed before the abort).
//  - any other error → rethrow (a real bug must not be swallowed into a
//    silent clean/continue).
export function scanTodo(text, ghRunner = ghExec) {
  const inflight = parseInflight(text);
  const stale = [];
  const warnings = [];
  const skipped = [];
  let aborted = null;

  for (const line of inflight) {
    const entry = parseEntry(line);
    if (!entry.branch && !entry.pr) {
      continue; // nothing to resolve against
    }
    let result;
    try {
      result = resolveEntry(entry, ghRunner);
    } catch (err) {
      if (err instanceof GhTransient) {
        skipped.push({ entry, reason: err.message });
        continue;
      }
      if (err instanceof GhUnavailable) {
        aborted = { reason: err.message };
        break;
      }
      throw err; // taxonomy-external → a real bug, surface it (Finding 2)
    }
    if (result.status === "stale") {
      stale.push({ entry, merged: result.merged });
    } else if (result.status === "warn") {
      warnings.push({ entry, merged: result.merged });
    }
  }

  return { inflightCount: inflight.length, stale, warnings, skipped, aborted };
}

// Pure: turn a scan result into an exit code + message lines (no I/O, no
// throw). Exit 1 iff a genuine stale marker exists; otherwise 0 (fail-soft).
// The summary line always says "partial scan" when any entry was skipped or
// the scan aborted, so exit 0 never reads as "all verified clean".
export function summarize(scan) {
  const out = [];
  const err = [];
  const { inflightCount, stale, warnings, skipped, aborted } = scan;

  if (inflightCount === 0) {
    out.push("check-stale-todo-markers: no 🚧 in-flight entries — OK");
    return { exitCode: 0, out, err };
  }

  const partial = skipped.length > 0 || Boolean(aborted);

  for (const { entry, merged } of warnings) {
    err.push(`  ⚠ ${entry.title}`);
    err.push(
      `      PR #${merged.number} looks MERGED (number-only match — verify): ${merged.title}`
    );
  }
  for (const { entry, reason } of skipped) {
    err.push(`  … skipped (transient gh error): ${entry.title}\n      (${reason})`);
  }
  if (aborted) {
    err.push(
      `  … scan stopped early — gh became unavailable; remaining entries unchecked.\n      (${aborted.reason})`
    );
  }

  if (stale.length === 0) {
    const scope = partial ? "partial scan" : "checked";
    const noun = inflightCount === 1 ? "entry" : "entries";
    out.push(
      `check-stale-todo-markers: ${inflightCount} 🚧 in-flight ${noun} (${scope}), none stale — OK` +
        (warnings.length ? ` (${warnings.length} number-only warning(s) above)` : "")
    );
    return { exitCode: 0, out, err };
  }

  err.unshift(
    `check-stale-todo-markers: ${stale.length} STALE 🚧 marker(s)` +
      (partial ? " (partial scan — some entries unchecked)" : "") +
      "\n"
  );
  for (const { entry, merged } of stale) {
    const via = entry.branch ? `branch: ${entry.branch}` : `PR #${merged.number}`;
    err.push(`  ✗ ${entry.title}`);
    err.push(`      ${via} — PR #${merged.number} is MERGED: ${merged.title}`);
  }
  err.push(
    "\nRemediation: the PR(s) above merged outside /merge-pr, so the 🚧 entry was\n" +
      "never archived. Move each stale entry from the TODO file into TODO-archive.md\n" +
      "(collapse to a one-line ✅ entry), then re-run this check. Going forward, merge\n" +
      "through /merge-pr so its post-merge sync handles this automatically."
  );
  return { exitCode: 1, out, err };
}

// Wrap summarize(scanTodo(...)) so a taxonomy-external error (a real bug) maps
// to exit 2 — distinct from stale's exit 1 — instead of crashing with Node's
// default exit 1 (which would read as "stale found"). The testable exit-2 seam.
export function runScan(text, ghRunner = ghExec) {
  try {
    return summarize(scanTodo(text, ghRunner));
  } catch (e) {
    return {
      exitCode: 2,
      out: [],
      err: [`check-stale-todo-markers: internal error — ${e?.message ?? String(e)}`],
    };
  }
}

function main() {
  const todoPath = process.argv[2] ?? DEFAULT_TODO;
  let text;
  try {
    text = readFileSync(todoPath, "utf8");
  } catch (err) {
    console.error(`check-stale-todo-markers: cannot read ${todoPath}: ${err.message}`);
    process.exit(2);
  }

  const { exitCode, out, err } = runScan(text);
  for (const line of out) {
    console.log(line);
  }
  for (const line of err) {
    console.error(line);
  }
  process.exit(exitCode);
}

// Only run main when invoked directly (not when imported by the test suite).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { DEFAULT_TODO };
