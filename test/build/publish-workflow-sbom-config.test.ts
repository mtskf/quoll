// Pins the publish.yml -> syft config wiring that makes the release SBOM non-empty.
//
// Both halves are load-bearing: `.github/syft-release.yaml` re-enables syft's
// package.json cataloger, and the sbom-action step must actually pass it via
// `config:`. Dropping either yields an SBOM with ZERO npm packages — what
// happened on the v0.1.66 tag. WHY syft behaves that way lives in
// .github/syft-release.yaml; don't restate it here (four copies of the same
// rationale is four places to go stale on the next syft bump).
//
// verify-sbom-scope.mjs remains the authoritative runtime check, but it only
// runs on a `v*` tag. This is the cheap static guard so the regression surfaces
// on the PR instead of mid-release.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Strip YAML comments before asserting. Both files EXPLAIN this wiring in prose
// that names the same paths and cataloger, so a whole-file `toContain` would
// pass on the comments alone even if the real key were deleted.
function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

// The contract is "the SBOM step passes these", not "the file mentions these
// somewhere" — a key that migrated to another step would satisfy a whole-file
// match while leaving the SBOM empty. Slice the named step's own block: from its
// `- name:` line to the next one at the same indent.
function stepBlock(workflow: string, name: string, label = "publish.yml"): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) {
    throw new Error(`step not found in ${label}: ${name}`);
  }
  // Terminate on the next step at THIS step's indent. An indent-agnostic match
  // would also fire on a `- name:` nested inside a future block scalar.
  const indent = lines[start].length - lines[start].trimStart().length;
  const nextStep = new RegExp(`^ {${indent}}- name:`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => nextStep.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// Slice one job's block out of a workflow: from `  <job>:` to the next key at the
// same two-space indent. Steps must be compared WITHIN the intended job — a
// whole-file step lookup would happily match a step that migrated into the wrong
// job, which is precisely the drift we are guarding against.
function jobBlock(workflow: string, job: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start === -1) {
    throw new Error(`job not found: ${job}`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("release SBOM cataloger wiring", () => {
  const workflow = stripComments(read(".github/workflows/publish.yml"));
  const syftConfig = stripComments(read(".github/syft-release.yaml"));
  const sbomStep = stepBlock(workflow, "Generate SBOM (SPDX)");

  it("passes the syft config to the SBOM action", () => {
    expect(sbomStep).toContain("config: .github/syft-release.yaml");
  });

  it("scans the prod-only staging tree, not the workspace", () => {
    // A workspace scan would re-include devDependencies and fail the scope gate.
    // Regex (not toContain) so the GitHub Actions `${{ }}` expression does not
    // read as a JS template placeholder to the linter.
    expect(sbomStep).toMatch(/path:\s*\$\{\{\s*runner\.temp\s*\}\}\/sbom-src/);
  });

  it("enables the package.json cataloger additively", () => {
    expect(syftConfig).toContain("select-catalogers:");
    // The leading `+` is required SYNTAX, not decoration: syft's set operation
    // accepts only tags, so a bare name is rejected outright ("names are not
    // allowed with this operation"). The `+` operator is what makes the
    // expression an addition to the default cataloger set. Verified against the
    // pinned syft v1.42.3 — a bare name exits non-zero rather than replacing
    // the defaults, so this stays a fail-closed mistake, but pin it anyway.
    // Quotes optional: `+` is not a YAML indicator, so the unquoted scalar is
    // equally valid and equally correct — the `+` is what we are pinning.
    expect(syftConfig).toMatch(/-\s*"?\+javascript-package-cataloger"?/);
  });
});

// The CI rehearsal is only worth something if it runs the SAME sequence the
// release runs, and nothing in GitHub Actions enforces that. Dependabot is not
// the threat here — it updates every reference to an action across all workflow
// files in ONE PR, which is why these assertions do not false-positive on its
// bumps. The threat is a hand edit, a bad conflict resolution, or a "quick fix"
// applied to one file only, quietly degrading the rehearsal into theatre.
describe("CI rehearses the release SBOM sequence", () => {
  const publishJob = jobBlock(stripComments(read(".github/workflows/publish.yml")), "publish");
  const sbomJob = jobBlock(stripComments(read(".github/workflows/ci.yml")), "sbom");
  // Comment-preserving slices — the SHA-pin assertion below checks the trailing
  // `# vX.Y.Z` comment that stripComments() removes by design.
  const rawPublishJob = jobBlock(read(".github/workflows/publish.yml"), "publish");
  const rawSbomJob = jobBlock(read(".github/workflows/ci.yml"), "sbom");

  const normalise = (block: string) =>
    block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .join("\n");

  // Every step of the release SBOM sequence, in order. `--reconcile` is shadow
  // (non-gating) in BOTH files: when the separate "promote reconcile to gating"
  // entry lands, this assertion forces both to flip together.
  const SHARED_STEPS = [
    "Assemble shipped runtime dependency tree (SBOM source)",
    "Generate SBOM (SPDX)",
    "Verify SBOM is scoped to the shipped runtime",
    "Reconcile SBOM against staged install (shadow, non-gating)",
  ];

  it.each(SHARED_STEPS)("runs `%s` identically in both workflows", (step) => {
    expect(normalise(stepBlock(sbomJob, step, "ci.yml"))).toBe(
      normalise(stepBlock(publishJob, step))
    );
  });

  // Non-vacuity: identical-but-empty blocks would satisfy the equality above, so
  // pin the load-bearing content of each step independently.
  it("keeps the load-bearing content of each shared step", () => {
    expect(stepBlock(sbomJob, SHARED_STEPS[0], "ci.yml")).toContain(
      'scripts/assemble-sbom-staging.sh "$RUNNER_TEMP/sbom-src"'
    );
    expect(stepBlock(sbomJob, SHARED_STEPS[1], "ci.yml")).toContain(
      "config: .github/syft-release.yaml"
    );
    expect(stepBlock(sbomJob, SHARED_STEPS[2], "ci.yml")).toContain(
      "node scripts/verify-sbom-scope.mjs sbom.spdx.json"
    );
    expect(stepBlock(sbomJob, SHARED_STEPS[3], "ci.yml")).toContain(
      '--reconcile "$RUNNER_TEMP/sbom-src"'
    );
  });

  // Per-step equality says nothing about ORDER, ADJACENCY, or UNIQUENESS: a
  // named step inserted between Generate and Verify in one file only, a
  // reordering, or a duplicate step name all leave every assertion above green.
  // Pin the sequence itself.
  // Anchored to the step indent (6 spaces inside a job) rather than trimmed:
  // a trimmed match would also pick up a `- name:`-looking line inside a future
  // `run: |` block scalar and silently shift the sequence.
  const stepNames = (job: string) =>
    job
      .split("\n")
      .filter((line) => /^ {6}- name: /.test(line))
      .map((line) => line.replace(/^ {6}- name: /, ""));

  it.each([
    ["publish.yml", publishJob],
    ["ci.yml", sbomJob],
  ])("runs the shared steps consecutively and in order in %s", (_label, job) => {
    const names = stepNames(job);
    for (const step of SHARED_STEPS) {
      expect(names.filter((n) => n === step)).toHaveLength(1);
    }
    const start = names.indexOf(SHARED_STEPS[0]);
    expect(names.slice(start, start + SHARED_STEPS.length)).toEqual(SHARED_STEPS);
  });

  // Equality alone is satisfied by two files that BOTH regressed — e.g. both
  // moved to a mutable `@v0` tag. Pin the pin itself: a 40-hex commit SHA with
  // the trailing version comment the repo-wide policy requires. Anchored to the
  // SBOM step inside the relevant job, because a whole-file match would be
  // satisfied by a correct-looking `uses:` line sitting in a comment or in some
  // unrelated step while the real one regressed.
  it.each([
    ["publish.yml", rawPublishJob],
    ["ci.yml", rawSbomJob],
  ])("pins anchore/sbom-action to a 40-hex SHA in %s", (label, rawJob) => {
    // 8 spaces = a step's own attributes, so this cannot be satisfied by a
    // `uses:` line at some other depth that happens to look right.
    expect(stepBlock(rawJob, "Generate SBOM (SPDX)", label)).toMatch(
      /^ {8}uses: anchore\/sbom-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/m
    );
  });

  // The staging tree's contents depend on the checkout and on the pnpm/Node
  // versions that build it, not just on the steps that consume it — a
  // divergence there would make the rehearsal scan a different closure while
  // every step still matched. Job-scoped on both sides: `build`'s own pins are
  // none of this test's business, and coupling them would make a legitimate
  // Node bump in `build` fail a test about the SBOM staging tree.
  it("resolves the staging tree with the same checkout, pnpm and Node pins", () => {
    const pins = (job: string) => ({
      checkout: job.match(/actions\/checkout@[0-9a-f]{40}/g) ?? [],
      pnpmAction: job.match(/pnpm\/action-setup@[0-9a-f]{40}/g) ?? [],
      setupNode: job.match(/actions\/setup-node@[0-9a-f]{40}/g) ?? [],
      pnpmVersion: job.match(/version: \d+\.\d+\.\d+/g) ?? [],
      nodeVersion: job.match(/node-version: '[^']+'/g) ?? [],
    });
    expect(pins(sbomJob)).toEqual(pins(publishJob));
  });
});
