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
function stepBlock(workflow: string, name: string): string {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start === -1) {
    throw new Error(`step not found in publish.yml: ${name}`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\s*- name:/.test(line));
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
