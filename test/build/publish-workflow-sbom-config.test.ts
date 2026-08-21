// Pins the publish.yml -> syft config wiring that makes the release SBOM non-empty.
//
// Both halves are load-bearing: `.github/syft-release.yaml` re-enables syft's
// package.json cataloger, and the sbom-action step must actually pass it via
// `config:`. Dropping either yields an SBOM with ZERO npm packages — what
// happened on the v0.1.66 tag. WHY syft behaves that way lives in
// .github/syft-release.yaml; don't restate it here (four copies of the same
// rationale is four places to go stale on the next syft bump).
//
// verify-sbom-scope.mjs is the authoritative runtime check. Since the `sbom` job
// landed in ci.yml it runs on every PR too, not only on a `v*` tag — this file
// is the static half of that guard: it pins the wiring (config passing,
// cataloger selection) and pins the CI rehearsal to the release sequence, so a
// regression surfaces at review time rather than mid-release.
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

// Read each file once, here, so the workflow paths live in one place. Both a raw
// and a comment-stripped view are needed: the SHA-pin assertion checks a
// trailing `# vX.Y.Z` comment that stripComments() removes by design.
const publishYml = read(".github/workflows/publish.yml");
const ciYml = read(".github/workflows/ci.yml");

// The contract is "the SBOM step passes these", not "the file mentions these
// somewhere" — a key that migrated to another step would satisfy a whole-file
// match while leaving the SBOM empty. Slice the named step's own block: from its
// `- name:` line to the next one at the same indent.
// `label` names the file `workflow` came from — required, not defaulted: the two
// are halves of one fact, and a default bakes in one caller's answer, so a
// lookup against ci.yml would report "not found in publish.yml".
function stepBlock(workflow: string, name: string, label: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) {
    throw new Error(`step not found in ${label}: ${name}`);
  }
  // Terminate on the next step at THIS step's indent — named or not. An
  // indent-agnostic match would also fire on a `- name:` nested inside a future
  // block scalar; terminating only on `- name:` would absorb a following
  // UNNAMED step (how this repo writes every `actions/*` setup step) into this
  // block, failing the equality test under the wrong step's name.
  const indent = lines[start].length - lines[start].trimStart().length;
  const nextStep = new RegExp(`^ {${indent}}- `);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => nextStep.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// Slice one job's block out of a workflow: from `  <job>:` to the next key at the
// same two-space indent. Steps must be compared WITHIN the intended job — a
// whole-file step lookup would happily match a step that migrated into the wrong
// job, which is precisely the drift we are guarding against.
function jobBlock(workflow: string, job: string, label: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${job}:`);
  if (start === -1) {
    throw new Error(`job not found in ${label}: ${job}`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

describe("release SBOM cataloger wiring", () => {
  const workflow = stripComments(publishYml);
  const syftConfig = stripComments(read(".github/syft-release.yaml"));
  const sbomStep = stepBlock(workflow, "Generate SBOM (SPDX)", "publish.yml");

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
// release runs, and nothing in GitHub Actions enforces that. The threat is a
// hand edit, a bad conflict resolution, or a "quick fix" applied to one file
// only, quietly degrading the rehearsal into theatre. Dependabot is very likely
// not the threat: it updates a given dependency across every file it finds under
// the configured directory in one PR, so a SHA appearing in both workflows
// should move in both at once. (That comes from the per-dependency
// directory-wide scan — NOT from `dependabot.yml`'s `groups:`, which only
// bundles DIFFERENT dependencies into a single PR.) We do not depend on that
// holding, though: if a bump ever did arrive split across PRs, the red would be
// a TRUE positive — the files really would have diverged — so the assertion is
// correct either way.
describe("CI rehearses the release SBOM sequence", () => {
  const publishJob = jobBlock(stripComments(publishYml), "publish", "publish.yml");
  const sbomJob = jobBlock(stripComments(ciYml), "sbom", "ci.yml");
  const rawPublishJob = jobBlock(publishYml, "publish", "publish.yml");
  const rawSbomJob = jobBlock(ciYml, "sbom", "ci.yml");

  const normalise = (block: string) =>
    block
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim() !== "")
      .join("\n");

  // Every step of the release SBOM sequence, in order. `--reconcile` is folded
  // into the gating verify step in BOTH files, so a one-sided edit to it fails
  // here. `as const` + the exhaustive Record below make the pairing total:
  // adding a step here without giving it a load-bearing needle fails, so a
  // future step cannot silently fall back to the (vacuity-prone) equality
  // assertion alone.
  const SHARED_STEPS = [
    "Assemble shipped runtime dependency tree (SBOM source)",
    "Generate SBOM (SPDX)",
    "Verify SBOM is scoped to the shipped runtime",
  ] as const;
  type SharedStep = (typeof SHARED_STEPS)[number];

  // Non-vacuity: identical-but-empty blocks would satisfy the equality below, so
  // pin the load-bearing content of each step independently. Regexes (not
  // substrings) because the shell `${VAR:?…}` guard would otherwise read as a JS
  // template placeholder to the linter.
  const LOAD_BEARING: Record<SharedStep, RegExp> = {
    "Assemble shipped runtime dependency tree (SBOM source)":
      /scripts\/assemble-sbom-staging\.sh "\$\{RUNNER_TEMP:\?RUNNER_TEMP is not set\}\/sbom-src"/,
    "Generate SBOM (SPDX)": /config: \.github\/syft-release\.yaml/,
    // Both halves of the gate: the script AND the `--reconcile` flag that makes
    // it compare the SBOM against the staging tree's real manifests. Dropping
    // the flag in both files would leave a bare-script needle green while the
    // gate silently reverted to the syntax-only check.
    "Verify SBOM is scoped to the shipped runtime":
      /node scripts\/verify-sbom-scope\.mjs sbom\.spdx\.json --reconcile "\$\{RUNNER_TEMP:\?RUNNER_TEMP is not set\}\/sbom-src"/,
  };

  it.each(SHARED_STEPS)("runs `%s` identically in both workflows", (step) => {
    expect(normalise(stepBlock(sbomJob, step, "ci.yml"))).toBe(
      normalise(stepBlock(publishJob, step, "publish.yml"))
    );
  });

  it.each(SHARED_STEPS)("keeps the load-bearing content of `%s`", (step) => {
    // Assert the needle EXISTS before using it. The `Record<SharedStep, …>` type
    // above looks like it already makes that impossible, but nothing enforces it
    // here: `test/build/` is in none of the four tsconfigs `pnpm compile` runs
    // (the trap CLAUDE.md documents for test/markdown and test/shared), so the
    // exhaustiveness check never executes — and at runtime a missing entry makes
    // this `expect(…).toMatch(undefined)`, which vitest PASSES silently. Without
    // this line a forgotten entry ships with zero enforcement: verified by
    // deleting one and watching the whole suite stay green.
    const needle = LOAD_BEARING[step];
    expect(needle).toBeDefined();
    expect(stepBlock(sbomJob, step, "ci.yml")).toMatch(needle);
  });

  // The reconcile is a GATE, so pin the step's SHAPE rather than blocklisting
  // ways to un-gate it. A blocklist of swallow spellings (`||`,
  // `continue-on-error:`) misses the sneakiest one outright: rewriting the step
  // as a `run: |` block scalar around `set +e; <original command>; exit 0`
  // contains neither string, keeps the LOAD_BEARING needle green (the original
  // command text sits unchanged inside the block), and still discards the exit
  // code the gate is made of. Verified by hand: that rewrite leaves every other
  // assertion in this suite green. Another blocklist entry is just a checklist
  // the next swallow spelling dodges.
  //
  // So anchor the WHOLE normalised block (no `/m`) against the exact one-line
  // command this step is today. Anything that turns it into more than one line
  // — the block-scalar rewrite above, a step-level `continue-on-error: true` —
  // fails the single-line anchor, whether or not it also swallows the status.
  it.each([
    ["publish.yml", publishJob],
    ["ci.yml", sbomJob],
  ])("keeps the SBOM verify step fail-closed in %s", (label, job) => {
    const step = stepBlock(job, "Verify SBOM is scoped to the shipped runtime", label);
    expect(normalise(step)).toMatch(
      /^ {8}run: node scripts\/verify-sbom-scope\.mjs sbom\.spdx\.json --reconcile "\$\{RUNNER_TEMP:\?RUNNER_TEMP is not set\}\/sbom-src"$/
    );
  });

  // Per-step equality says nothing about ORDER, ADJACENCY, or UNIQUENESS: a
  // named step inserted between Generate and Verify in one file only, a
  // reordering, or a duplicate step name all leave every assertion above green.
  // Pin the sequence itself.
  // EVERY step, not just the named ones. Anchored to the step indent (6 spaces
  // inside a job) rather than trimmed, so a `- `-looking line inside a future
  // `run: |` block scalar cannot shift the sequence.
  //
  // Unnamed steps must appear here or the adjacency assertion below has a hole:
  // this repo writes every `actions/*` setup step as a bare `- uses:`, and
  // splicing one BETWEEN two shared steps is invisible to a names-only list —
  // the equality blocks stop at it (stepBlock terminates on `- `), so nothing
  // else would catch it either. Placeholder-name the unnamed ones so they still
  // occupy a slot in the ordering.
  const stepLabels = (job: string) =>
    job
      .split("\n")
      .filter((line) => /^ {6}- /.test(line))
      .map((line) => {
        const named = line.match(/^ {6}- name: (.*)$/);
        return named ? named[1] : "<unnamed step>";
      });

  it.each([
    ["publish.yml", publishJob],
    ["ci.yml", sbomJob],
  ])("runs the shared steps consecutively and in order in %s", (_label, job) => {
    const labels = stepLabels(job);
    for (const step of SHARED_STEPS) {
      expect(labels.filter((n) => n === step)).toHaveLength(1);
    }
    const start = labels.indexOf(SHARED_STEPS[0]);
    expect(labels.slice(start, start + SHARED_STEPS.length)).toEqual([...SHARED_STEPS]);
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
  it("resolves the staging tree with the same runner, checkout, pnpm and Node pins", () => {
    const pins = (job: string) => ({
      // The runner image is an input to the resolved closure too
      // (platform-specific optionalDependencies), so a divergence here is the
      // same class of drift.
      runsOn: job.match(/runs-on: \S+/g) ?? [],
      checkout: job.match(/actions\/checkout@[0-9a-f]{40}/g) ?? [],
      pnpmAction: job.match(/pnpm\/action-setup@[0-9a-f]{40}/g) ?? [],
      setupNode: job.match(/actions\/setup-node@[0-9a-f]{40}/g) ?? [],
      // Anchored to pnpm/action-setup's own `with:` block — a bare `version:`
      // matches any future versioned action in either job (and matches inside
      // `node-version: 22.11.0`).
      pnpmVersion:
        job.match(/pnpm\/action-setup@[0-9a-f]{40}\n\s*with:\n\s*version: \d+\.\d+\.\d+/g) ?? [],
      nodeVersion: job.match(/node-version: '[^']+'/g) ?? [],
    });
    const sbomPins = pins(sbomJob);
    // Non-vacuity: `?? []` makes "pin absent from BOTH jobs" indistinguishable
    // from "pins agree", so a coordinated move to a mutable tag — or a quoting
    // change that empties a style-bound regex — would leave this green. Assert
    // presence, then equality.
    for (const [kind, matches] of Object.entries(sbomPins)) {
      expect(matches, `no ${kind} pin matched in ci.yml's sbom job`).not.toHaveLength(0);
    }
    expect(sbomPins).toEqual(pins(publishJob));
  });

  // Everything above pins what the gate RUNS. Two things decide whether running
  // it red actually stops anything, and both live outside every step block.
  //
  // First, the interpreter. A `run:` step's shell comes from the job's (or the
  // workflow's) `defaults.run.shell`, and a custom shell template's exit code
  // IS the step outcome — so `shell: bash -c "bash {0}; exit 0" bash` on the
  // job makes every step succeed while still executing. Measured: that
  // mutation leaves every other assertion in this suite green. Pin the header
  // by SHAPE, the same way the step anchor does: both jobs declare exactly
  // `runs-on`, so a job-level `continue-on-error:`, `if:`, or `defaults:`
  // cannot appear without changing the header — and check the workflow level
  // too, which no job block would ever show.
  it.each([
    ["publish.yml", publishYml, publishJob],
    ["ci.yml", ciYml, sbomJob],
  ])("keeps the gate's execution context unmodified in %s", (_label, raw, job) => {
    const header = normalise(job.slice(0, job.indexOf("    steps:")));
    expect(header).toBe("    runs-on: ubuntu-latest");
    expect(stripComments(raw)).not.toMatch(/^defaults:/m);
  });

  // Second, in publish.yml only: a red verify step blocks the release solely
  // because every later step carries the implicit `if: success()`. Nothing else
  // pins that, so `if: always()` on Package / Audit / Publish ships the release
  // — unattested — straight past a failed gate, with this suite green. GHA has
  // exactly three status functions that resurrect a step after a failure
  // (`always()`, `failure()`, `cancelled()`), so naming them is a closed
  // contract rather than the blocklist-of-spellings this file keeps rejecting.
  it("keeps a red gate blocking every later publish.yml step", () => {
    expect(publishJob).not.toMatch(/^\s+if:.*\b(?:always|failure|cancelled)\s*\(/m);
  });

  // The ci.yml rehearsal only rehearses if it can FAIL the PR — which also
  // needs the trigger itself to stay put (a job header pinned to `runs-on`
  // says nothing about `on:`).
  it("keeps the sbom rehearsal gating on every PR", () => {
    expect(stripComments(ciYml)).toMatch(/^on:\n\s+pull_request:/m);
  });
});
