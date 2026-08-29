// Pins the invariants that make token-liveness.yml safe to run on a schedule.
//
// The workflow exists to hold LIVE publish credentials for both registries and
// ask each one "is this token still good?". That makes two properties
// load-bearing, and neither is enforced by anything GitHub checks:
//
//  1. READ-ONLY. It must never invoke a publishing subcommand. The whole point
//     is to move token discovery OFF the release path; a `publish` reachable
//     from a weekly cron would put a release back onto it.
//  2. NOT REACHABLE FROM UNTRUSTED-ISH EVENTS. `schedule` + `workflow_dispatch`
//     only. Adding `pull_request` or `push` would hand the publish PATs to every
//     branch build — i.e. to anyone who can push a branch — for a check whose
//     verdict does not depend on the branch.
//
// And one behavioural invariant that is easy to lose in an edit but is the
// reason the workflow was written at all: BOTH tokens get a verdict every run.
// `OPENVSX_PAT` sat invalid for ~5 releases precisely because one failure hid
// behind another.
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

const MARKETPLACE_STEP = "Verify VS Code Marketplace token (VSCODE_PAT)";
const OPENVSX_STEP = "Verify Open VSX token (OPENVSX_PAT)";

describe("token liveness workflow is read-only", () => {
  // Every line that names either registry CLI, comments already removed.
  const cliLines = workflow
    .split("\n")
    .filter((line) => /\b(?:vsce|ovsx)\b/.test(line))
    .map((line) => line.trim());

  it("only ever invokes the registry CLIs with verify-pat", () => {
    // An ALLOWLIST of the whole invocation, not a denylist of known-bad
    // subcommands. A denylist ("must not contain `publish`") is both over- and
    // under-broad here: the steps' own error text legitimately says "publish.yml
    // would fail at its Marketplace publish step", while a future
    // `ovsx create-namespace` — a write — would sail past it. Matching on the
    // CLI name instead also catches an invocation that bypasses `pnpm exec`
    // (a bare binary, npx). Case-sensitive by design: the `VSCE_PAT` /
    // `OVSX_PAT` env var names are not invocations and do not match.
    //
    // Pinning the full line covers the second half of the rule in the same
    // assertion: the token is never passed as `-p <token>` / `--pat <token>`,
    // where it would land in the runner's process arguments. Both CLIs read it
    // from the environment instead — the rule publish.yml's publish steps
    // follow. Equality (not `every()`) so a rename that stops matching cannot
    // leave an empty list quietly passing.
    expect(cliLines).toEqual([
      'pnpm exec vsce verify-pat "$PUBLISHER"',
      'pnpm exec ovsx verify-pat "$NAMESPACE"',
    ]);
  });

  it("grants the workflow token no write scope", () => {
    expect(topLevelBlock(workflow, "permissions").trim()).toBe("contents: read");
  });
});

describe("token liveness workflow is not reachable from branch events", () => {
  const triggers = topLevelBlock(workflow, "on");

  it("runs on a schedule and on manual dispatch", () => {
    expect(triggers).toMatch(/^\s+schedule:$/m);
    expect(triggers).toMatch(/^\s+- cron: /m);
    expect(triggers).toMatch(/^\s+workflow_dispatch:$/m);
  });

  it("does not run on push or pull_request", () => {
    // Either trigger would expose both publish PATs to every branch build. The
    // check's verdict is branch-independent, so there is no version of this
    // workflow that needs them.
    expect(triggers).not.toMatch(/^\s+(?:push|pull_request|pull_request_target):/m);
  });
});

describe("token liveness workflow reports on both tokens", () => {
  it("probes each secret in its own step", () => {
    expect(stepBlock(workflow, MARKETPLACE_STEP)).toMatch(
      /VSCE_PAT:\s*\$\{\{\s*secrets\.VSCODE_PAT\s*\}\}/
    );
    expect(stepBlock(workflow, OPENVSX_STEP)).toMatch(
      /OVSX_PAT:\s*\$\{\{\s*secrets\.OPENVSX_PAT\s*\}\}/
    );
  });

  it("keeps a failing Marketplace probe from masking the Open VSX one", () => {
    // Default step behaviour is fail-fast: without this `if:`, a dead
    // VSCODE_PAT skips the Open VSX probe entirely and the run reports one
    // problem where there may be two. That is the exact shape of the incident
    // this workflow was written for.
    expect(stepBlock(workflow, OPENVSX_STEP)).toMatch(/^\s+if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}$/m);
  });

  it("fails loudly on an empty secret instead of falling through to a prompt", () => {
    // With no token in the environment BOTH CLIs fall back to interactive input
    // (vsce: credential store then `read()`; ovsx: `getPAT` then
    // `getUserInput`). On a runner that is a hang or an opaque stdin error —
    // the one failure mode a liveness ping must not have.
    // Regex rather than toContain: the shell's `${VAR:-}` reads as a JS template
    // placeholder to the linter inside a plain string literal.
    expect(stepBlock(workflow, MARKETPLACE_STEP)).toMatch(/if \[ -z "\$\{VSCE_PAT:-\}" \]; then/);
    expect(stepBlock(workflow, OPENVSX_STEP)).toMatch(/if \[ -z "\$\{OVSX_PAT:-\}" \]; then/);
  });
});
