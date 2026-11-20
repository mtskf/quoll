// Pins the invariants that make token-liveness.yml safe to run on a schedule.
//
// The workflow exists to hold a LIVE publish credential (OPENVSX_PAT) and ask
// Open VSX "is this token still good?". That makes two properties
// load-bearing, and neither is enforced by anything GitHub checks:
//
//  1. READ-ONLY. It must never invoke a publishing subcommand. The whole point
//     is to move token discovery OFF the release path; a `publish` reachable
//     from a weekly cron would put a release back onto it.
//  2. NOT REACHABLE FROM UNTRUSTED-ISH EVENTS. `schedule` + `workflow_dispatch`
//     only. Adding `pull_request` or `push` would hand the publish PAT to every
//     branch build — i.e. to anyone who can push a branch — for a check whose
//     verdict does not depend on the branch.
//
// The Marketplace is published via OIDC Trusted Publishing, so there is no
// Marketplace PAT to probe; the suite also pins that the retired VSCODE_PAT
// secret stays out of this file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowPath = ".github/workflows/token-liveness.yml";
const raw = readFileSync(fileURLToPath(new URL(`../../${workflowPath}`, import.meta.url)), "utf8");

// Strip YAML comments before asserting. The file EXPLAINS these invariants in a
// header that names `vsce publish`, `ovsx publish` and `pull_request` in prose —
// a raw-text assertion would read that prose as the thing it forbids and fail on
// a correct file. Comment-stripping is what makes these assertions about the
// wiring rather than about the documentation of the wiring.
function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

// Slice a top-level block: from `<key>:` at column 0 to the next column-0 key.
function topLevelBlock(yaml: string, key: string): string {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`${key}:`);
  if (start === -1) {
    throw new Error(`top-level key not found in ${workflowPath}: ${key}`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// Slice one step, from its `- name:` line to the next entry at the same indent.
// Assertions about a step's own `if:` / `env:` have to be scoped to that step —
// a whole-file match would be satisfied by the guard sitting on the wrong one.
function stepBlock(yaml: string, name: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) {
    throw new Error(`step not found in ${workflowPath}: ${name}`);
  }
  const indent = lines[start].length - lines[start].trimStart().length;
  const nextEntry = new RegExp(`^ {${indent}}- `);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => nextEntry.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

const workflow = stripComments(raw);

const OPENVSX_STEP = "Verify Open VSX token (OPENVSX_PAT)";

describe("token liveness workflow is read-only", () => {
  // Every line that names a registry CLI, comments already removed.
  const cliLines = workflow
    .split("\n")
    .filter((line) => /\b(?:vsce|ovsx)\b/.test(line))
    .map((line) => line.trim());

  it("only ever invokes a registry CLI with verify-pat", () => {
    // An ALLOWLIST of the whole invocation, not a denylist of known-bad
    // subcommands. A denylist ("must not contain `publish`") is both over- and
    // under-broad here: the step's error names the "Open VSX publish job",
    // while a future `ovsx create-namespace` — a
    // write — would sail past it. Matching on the CLI name (`vsce` included, so
    // a reintroduced Marketplace call cannot slip in unpinned) also catches an
    // invocation that bypasses `pnpm exec` (a bare binary, npx). Case-sensitive
    // by design: the `OVSX_PAT` env var name is not an invocation and does not
    // match.
    //
    // Pinning the full line covers the second half of the rule in the same
    // assertion: the token is never passed as `-p <token>` / `--pat <token>`,
    // where it would land in the runner's process arguments. `ovsx` reads it
    // from the environment instead — the rule publish.yml's Open VSX step
    // follows. Equality (not `every()`) so a rename that stops matching cannot
    // leave an empty list quietly passing.
    expect(cliLines).toEqual(['pnpm exec ovsx verify-pat "$NAMESPACE"']);
  });

  it("grants the workflow token no write scope", () => {
    expect(topLevelBlock(workflow, "permissions").trim()).toBe("contents: read");
  });
});

describe("token liveness workflow is not reachable from branch events", () => {
  const triggers = topLevelBlock(workflow, "on");

  it("runs on schedule + workflow_dispatch and nothing else", () => {
    // An allowlist, matching how this file pins the CLI invocations. The previous
    // denylist named only push / pull_request(_target); a fourth secret-reachable
    // trigger — `issue_comment`, `workflow_run` — sailed past it, which is the
    // vacuity class this suite exists to catch. Any such trigger would hand the
    // publish PAT to a branch build, for a check whose verdict does not depend
    // on the branch.
    const triggerKeys = triggers
      .split("\n")
      .filter((line) => /^ {2}\S/.test(line))
      .map((line) => line.trim());
    expect(triggerKeys).toEqual(["schedule:", "workflow_dispatch:"]);
    // The schedule is what makes this a ping rather than a button; keep it pinned
    // separately, since the key list above cannot see whether `schedule:` is empty.
    expect(triggers).toMatch(/^\s+- cron: /m);
  });
});

describe("token liveness workflow probes only the Open VSX token", () => {
  it("feeds OPENVSX_PAT to the probe step", () => {
    expect(stepBlock(workflow, OPENVSX_STEP)).toMatch(
      /OVSX_PAT:\s*\$\{\{\s*secrets\.OPENVSX_PAT\s*\}\}/
    );
  });

  it("no longer references the retired VSCODE_PAT secret", () => {
    // Marketplace publishing moved to OIDC and the secret is deleted. Any live
    // reference would read an empty value and either fail every weekly run or,
    // worse, be "fixed" by recreating a long-lived PAT the release no longer
    // needs. Comments are stripped, so the header's history may still name it.
    expect(workflow).not.toMatch(/VSCODE_PAT|VSCE_PAT/);
  });

  it("fails loudly on an empty secret instead of falling through to a prompt", () => {
    // WHY this guard exists (`ovsx` prompts interactively on an empty token):
    // see the step's own comment in token-liveness.yml.
    // Regex rather than toContain: the shell's `${VAR:-}` reads as a JS template
    // placeholder to the linter inside a plain string literal.
    expect(stepBlock(workflow, OPENVSX_STEP)).toMatch(/if \[ -z "\$\{OVSX_PAT:-\}" \]; then/);
  });
});

describe("token liveness workflow fails closed", () => {
  it("fails loudly when package.json has no publisher", () => {
    // WHY the publisher is derived rather than hard-coded: see the "Resolve
    // publisher id" step's own comment in token-liveness.yml. Without this guard the
    // derivation degrades instead of failing: an empty id flows into the
    // probe, and what the run reports is an argument error dressed up as a
    // token verdict.
    expect(stepBlock(workflow, "Resolve publisher id")).toMatch(/if \[ -z "\$publisher" \]; then/);
  });

  it("refuses any ref but the main BRANCH, so a tag named main cannot pass", () => {
    // WHY the full ref and not `github.ref_name` (a tag can be named `main`):
    // see the guard step's own comment in token-liveness.yml. Pinning the
    // `refs/heads/` prefix is what makes the short-name form fail this test.
    const guard = stepBlock(workflow, "Refuse to run off the default branch");
    expect(guard).toMatch(/if \[ "\$GITHUB_REF" != "refs\/heads\/main" \]; then/);
    expect(guard).toContain("exit 1");
    expect(guard).not.toMatch(/ref_name/);
  });

  it("pins every action to a 40-hex commit SHA, not a mutable tag", () => {
    // The FORM, not the SHAs themselves: Dependabot bumps these routinely and
    // pinning the literal values would turn every routine bump PR red. What must
    // not drift is `@<40-hex> # vX.Y.Z` — a mutable tag is what the file's own
    // header calls out as the supply-chain risk, and this job hands a live
    // publish credential to whatever those actions resolve to.
    //
    // Reads `raw`, not the comment-stripped copy: the trailing `# vX.Y.Z` that
    // keeps a SHA humanly readable is exactly what `stripComments` removes.
    const usesLines = raw
      .split("\n")
      .filter((line) => /^\s*- uses: /.test(line))
      .map((line) => line.trim());
    expect(usesLines.length).toBe(3);
    for (const line of usesLines) {
      expect(line).toMatch(/^- uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });
});
