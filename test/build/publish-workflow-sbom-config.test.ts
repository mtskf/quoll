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

// Collects the sorted set of mapping keys `pattern` matches — the shared tail
// of jobAttributeKeys and topLevelKeys (only the indent, and whether comments
// need stripping first, differs between them). Quote-tolerant, because
// `"defaults":` and `defaults:` are the same key.
const mappingKeys = (text: string, pattern: RegExp) =>
  [...text.matchAll(pattern)].map((m) => m[1] ?? m[2] ?? m[3]).sort();

// The keys a job declares, wherever they sit: YAML mappings are unordered, so
// scanning only the slice before `steps:` misses `defaults:` written after it.
const jobAttributeKeys = (job: string) =>
  mappingKeys(job, /^ {4}(?:"([^"]*)"|'([^']*)'|([^\s:]+))\s*:/gm);

// A workflow-wide or job-level defaults.run.shell can discard a gate's exit
// code. Pin the surrounding key sets and keep step keys visible to text scans.
const topLevelKeys = (yaml: string) =>
  mappingKeys(stripComments(yaml), /^(?:"([^"]*)"|'([^']*)'|([^\s:]+))\s*:/gm);

function expectBlockSteps(job: string) {
  // Flow-mapped steps hide their attributes mid-line from the text helpers.
  for (const step of job.split("\n").filter((line) => /^ {6}- /.test(line))) {
    expect(step).toMatch(/^ {6}- (?:name|uses): [^\s{[&*!]/);
  }
}

// Unnamed setup steps also occupy a slot. Only the "consecutively" check
// compares adjacent slots, so only it catches an insertion between two named
// steps; callers that filter the list pin relative order alone.
const stepLabels = (job: string) =>
  job
    .split("\n")
    .filter((line) => /^ {6}- /.test(line))
    .map((line) => {
      const named = line.match(/^ {6}- name: (.*)$/);
      return named ? named[1] : "<unnamed step>";
    });

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
  const releaseBuildJob = jobBlock(stripComments(publishYml), "build", "publish.yml");
  const sbomJob = jobBlock(stripComments(ciYml), "sbom", "ci.yml");
  const rawReleaseBuildJob = jobBlock(publishYml, "build", "publish.yml");
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
      normalise(stepBlock(releaseBuildJob, step, "publish.yml"))
    );
  });

  it.each(SHARED_STEPS)("keeps the load-bearing content of `%s`", (step) => {
    // Assert the needle EXISTS before using it. The `Record<SharedStep, …>` type
    // above IS enforced now — this file carries no `@ts-nocheck` and
    // `test/build/tsconfig.json` type-checks the directory as `pnpm compile`'s
    // 5th project, so a forgotten entry fails the build (measured: dropping the
    // "Generate SBOM (SPDX)" entry yields TS2741 at the LOAD_BEARING literal).
    // Kept as a runtime belt-and-braces check anyway, because the failure mode
    // it covers is silent: if that type-level guarantee ever regresses, a
    // missing entry degrades this to `expect(…).toMatch(undefined)`, which
    // vitest PASSES.
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
    ["publish.yml", releaseBuildJob],
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
  it.each([
    ["publish.yml", releaseBuildJob],
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
    ["publish.yml", rawReleaseBuildJob],
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
    expect(sbomPins).toEqual(pins(releaseBuildJob));
  });

  // Everything above pins what the gate RUNS. What follows pins whether running
  // it red actually stops anything — decided entirely outside the step blocks.
  //
  // ⚠️ Scope, stated plainly: these assertions read YAML as TEXT. Successive
  // adversarial rounds each produced a fresh spelling that walked past the
  // previous version of them — a block-scalar `if: >-`, a quoted `"defaults":`
  // key, a job attribute written AFTER `steps:`, a capitalised `Always()`. The
  // helpers below answer that by reading KEY SETS structurally instead of
  // matching a line, which measurably closes all four, plus a flow-style JOB
  // (which makes `jobBlock` throw) and `<<:` merge keys at job level. A
  // flow-style STEP hides its keys mid-line from every line-oriented helper
  // here, so step openers are pinned to the two block forms this repo writes.
  //
  // Even so: "no spelling anyone thought to try got through" is not "no
  // spelling exists" — four review rounds each produced a new one, and the
  // last left YAML's explicit-key form (`? if` / `: always()` on separate
  // lines) open by construction. Only a real parse settles this, and the repo
  // has no YAML parser; adding one is a dependency decision, tracked as its own
  // task. Read these as a tripwire for the plausible mid-release edit, not as
  // proof the gate cannot be un-gated.

  it("keeps the gate's execution context unmodified in ci.yml", () => {
    expect(jobAttributeKeys(sbomJob)).toEqual(["runs-on", "steps"]);
    expect(topLevelKeys(ciYml)).toEqual(["concurrency", "jobs", "name", "on", "permissions"]);
    expectBlockSteps(sbomJob);
  });

  // The ci.yml rehearsal only rehearses if it can FAIL the PR — which also
  // needs the trigger itself to stay put (a job header pinned to `runs-on`
  // says nothing about `on:`).
  it("keeps the sbom rehearsal gating on every PR", () => {
    expect(stripComments(ciYml)).toMatch(/^on:\n\s+pull_request:/m);
  });
});

describe("registry split layout", () => {
  const workflow = stripComments(publishYml);
  const label = "publish.yml";
  const jobNames = [
    ...workflow.slice(workflow.indexOf("\njobs:\n")).matchAll(/^ {2}(\S[^:\n]*):/gm),
  ].map((match) => match[1]);
  const expectedJobs = ["build", "attest", "publish-marketplace", "publish-openvsx"];
  const buildJob = jobBlock(workflow, "build", label);

  function needs(job: string): string[] {
    const flow = job.match(/^ {4}needs: \[([a-z-]+(?:, [a-z-]+)*)\]$/m);
    if (!flow) {
      throw new Error("expected needs in flow style");
    }
    return flow[1].split(", ");
  }

  it("declares exactly the build, attest and registry jobs", () => {
    expect(jobNames).toEqual(expectedJobs);
  });

  it("keeps the build gate's execution context unmodified", () => {
    expect(topLevelKeys(publishYml)).toEqual(["jobs", "name", "on", "permissions"]);
    expect(jobAttributeKeys(buildJob)).toEqual(["outputs", "permissions", "runs-on", "steps"]);
    expectBlockSteps(buildJob);
  });

  it.each([
    { name: "attest", dependencies: ["build"] },
    { name: "publish-marketplace", dependencies: ["build", "attest"] },
    { name: "publish-openvsx", dependencies: ["build", "attest", "publish-marketplace"] },
  ])("gates $name on its predecessors", ({ name, dependencies }) => {
    // Directly needing build makes its output available to every consumer.
    // The preceding job's success is required for the next job to run.
    const job = jobBlock(workflow, name, label);
    expect(jobAttributeKeys(job)).toEqual(["needs", "permissions", "runs-on", "steps"]);
    expect(needs(job)).toEqual(dependencies);
    expectBlockSteps(job);
  });

  // The `permissions:` mapping opened at `indent`, as sorted `key: value`
  // lines; null when no block-style mapping opens there.
  const permissionsAt = (block: string, indent: number) => {
    const lines = block.split("\n");
    const start = lines.indexOf(`${" ".repeat(indent)}permissions:`);
    if (start === -1) {
      return null;
    }
    const entry = new RegExp(`^ {${indent + 2}}(\\S.*)$`);
    const entries: string[] = [];
    for (const line of lines.slice(start + 1)) {
      const match = line.match(entry);
      if (!match) {
        break;
      }
      entries.push(match[1]);
    }
    return entries.sort();
  };

  it("grants nothing beyond read at the workflow level", () => {
    expect(permissionsAt(workflow, 0)).toEqual(["contents: read"]);
  });

  it.each([
    { name: "build", permissions: ["contents: read"] },
    { name: "attest", permissions: ["attestations: write", "contents: read", "id-token: write"] },
    { name: "publish-marketplace", permissions: ["contents: read", "id-token: write"] },
    { name: "publish-openvsx", permissions: ["contents: read"] },
  ])("scopes $name to the permissions it uses", ({ name, permissions }) => {
    // Every step with id-token can mint an OIDC token for Trusted Publishing.
    expect(permissionsAt(jobBlock(workflow, name, label), 4)).toEqual(permissions);
  });

  const publisherActions = [
    "actions/checkout",
    "pnpm/action-setup",
    "actions/setup-node",
    "actions/download-artifact",
  ];

  it.each([
    { name: "attest", actions: ["actions/download-artifact", "actions/attest", "actions/attest"] },
    { name: "publish-marketplace", actions: publisherActions },
    { name: "publish-openvsx", actions: publisherActions },
  ])("runs only the SHA-pinned actions needed by $name", ({ name, actions }) => {
    const rawJob = jobBlock(publishYml, name, label);
    const uses = rawJob.split("\n").filter((line) => /^\s*(?:- )?uses\s*:/.test(line));
    expect(
      uses.map(
        (line) =>
          line.match(/^ {6,8}(?:- )?uses: ([\w.-]+\/[\w.-]+)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/)?.[1]
      )
    ).toEqual(actions);
  });

  const attestSteps = ["Attest build provenance", "Attest SBOM"];

  it("attests the downloaded VSIX and its SBOM only in attest", () => {
    const attest = jobBlock(workflow, "attest", label);
    for (const name of jobNames.filter((name) => name !== "attest")) {
      const job = jobBlock(workflow, name, label);
      expect(job).not.toMatch(/actions\/attest@/);
      for (const step of attestSteps) {
        expect(stepLabels(job)).not.toContain(step);
      }
    }
    expect(stepBlock(attest, "Attest SBOM", label)).toMatch(/^ {10}sbom-path: sbom\.spdx\.json$/m);
  });

  it.each(attestSteps)("keeps %s unconditional and fail-closed", (name) => {
    const step = stepBlock(jobBlock(workflow, "attest", label), name, label);
    expect(step).toMatch(/^ {8}uses: actions\/attest@/m);
    expect(step).toMatch(/^ {10}subject-path: extension\.vsix$/m);
    expect(step).not.toMatch(/^ {8}(?:"|')?(?:if|continue-on-error)(?:"|')?\s*:/m);
  });

  const registrySteps = [
    { registry: "marketplace", job: "publish-marketplace", step: "Publish to VS Code Marketplace" },
    { registry: "openvsx", job: "publish-openvsx", step: "Publish to Open VSX" },
  ];

  it.each(registrySteps)("publishes to $registry once from $job", ({ registry, job, step }) => {
    const block = stepBlock(jobBlock(workflow, job, label), step, label);
    const command = `run: scripts/publish-registry.sh ${registry} extension.vsix "$EXPECTED_SHA256"`;
    const runLines = block.split("\n").filter((line) => /^ {8}run:/.test(line));
    expect(runLines).toEqual([`        ${command}`]);
    expect(
      workflow.match(new RegExp(`scripts/publish-registry\\.sh ${registry}\\b`, "g"))
    ).toHaveLength(1);
    expect(block).not.toMatch(/continue-on-error/);
    expect(workflow).not.toMatch(/\b(?:vsce|ovsx) publish\b/);
  });

  it("hands off the VSIX and SBOM after the audit", () => {
    const buildSteps = stepLabels(buildJob);
    const audit = buildSteps.indexOf("Audit .vsix contents");
    expect(audit).not.toBe(-1);
    expect(audit).toBeLessThan(buildSteps.indexOf("Upload audited .vsix"));
    const upload = stepBlock(buildJob, "Upload audited .vsix", label);
    expect(upload).toMatch(/^ {10}path: \|\n {12}extension\.vsix\n {12}sbom\.spdx\.json$/m);
    expect(upload).toMatch(/^ {10}name: extension-vsix$/m);
  });

  it("records the audited VSIX digest and exposes it as a build output", () => {
    expect(buildJob).toMatch(
      /^ {4}outputs:\n {6}vsix-sha256: \$\{\{ steps\.digest\.outputs\.sha256 \}\}$/m
    );
    const order = ["Audit .vsix contents", "Record .vsix digest", "Upload audited .vsix"];
    expect(stepLabels(buildJob).filter((name) => order.includes(name))).toEqual(order);
    const record = stepBlock(buildJob, "Record .vsix digest", label);
    expect(record).toMatch(/^ {8}id: digest$/m);
    expect(record).toMatch(
      /^ {8}run: \|\n {10}checksum=\$\(sha256sum extension\.vsix\)\n {10}echo "sha256=\$\{checksum%% \*\}" >> "\$GITHUB_OUTPUT"$/m
    );
    expect(stepBlock(buildJob, "Upload audited .vsix", label)).toMatch(/^ {10}retention-days: 7$/m);
  });

  it.each([
    { name: "attest", orderedSteps: ["Verify .vsix digest", ...attestSteps] },
    ...registrySteps.map(({ job, step }) => ({ name: job, orderedSteps: [step] })),
  ])("downloads the audited artifact and checks build's digest in $name", ({
    name,
    orderedSteps,
  }) => {
    const job = jobBlock(workflow, name, label);
    const downloadName = "Download audited .vsix";
    const order = [downloadName, ...orderedSteps];
    expect(stepLabels(job).filter((step) => order.includes(step))).toEqual(order);
    const download = stepBlock(job, downloadName, label);
    expect(download).toMatch(/^ {8}uses: actions\/download-artifact@/m);
    expect(download).toMatch(/^ {10}name: extension-vsix$/m);
    // Attest checks inline. Both publishers check inside the helper before
    // invoking the CLI, which the mock-publisher test exercises.
    const check = stepBlock(job, orderedSteps[0], label);
    expect(check).toMatch(
      /^ {8}env:\n {10}EXPECTED_SHA256: \$\{\{ needs\.build\.outputs\.vsix-sha256 \}\}$/m
    );
    if (name === "attest") {
      expect(check).toMatch(
        /^ {8}run: echo "\$EXPECTED_SHA256 {2}extension\.vsix" \| sha256sum -c -$/m
      );
    }
    if (name === "publish-openvsx") {
      expect(check).toMatch(/^ {10}OVSX_PAT: \$\{\{ secrets\.OPENVSX_PAT \}\}$/m);
    }
  });

  // Read quoted keys and folded scalars so a spelling change cannot hide a
  // conditional that bypasses a failed prerequisite or silently skips a gate.
  const ifScalars = (job: string) => {
    const lines = job.split("\n");
    const scalars: string[] = [];
    lines.forEach((line, i) => {
      const match = line.match(/^(\s*)(?:"if"|'if'|if)\s*:(.*)$/);
      if (!match) {
        return;
      }
      const indent = match[1].length;
      const continuation: string[] = [];
      for (const next of lines.slice(i + 1)) {
        if (next.trim() !== "" && next.length - next.trimStart().length <= indent) {
          break;
        }
        continuation.push(next);
      }
      scalars.push([match[2], ...continuation].join("\n"));
    });
    return scalars;
  };

  it("collects a step-level if scalar from a fixture", () => {
    expect(
      ifScalars("    steps:\n      - name: Fixture\n        if: always()\n        run: exit 0")
    ).toEqual([" always()"]);
  });

  it("keeps the implicit success condition throughout the release chain", () => {
    const scalars = jobNames.flatMap((name) => ifScalars(jobBlock(workflow, name, label)));
    expect(scalars).toEqual([]);
    expect(jobNames).toEqual(expectedJobs);
  });

  it("lets any job or step failure block its dependents", () => {
    expect(workflow).not.toMatch(
      /^\s*(?:- )?(?:"continue-on-error"|'continue-on-error'|continue-on-error)\s*:/m
    );
  });
});
