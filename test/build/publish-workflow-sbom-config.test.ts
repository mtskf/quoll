// Pins the publish.yml -> syft config wiring that makes the release SBOM non-empty.
//
// syft splits its JavaScript catalogers by source type: the package.json
// cataloger is tagged image-only, while the lock cataloger is the one tagged
// for directory scans. publish.yml generates the SBOM from a prod-only staging
// tree whose lockfile is deliberately deleted (we want the INSTALLED closure,
// not the dev-inclusive lock graph), so the default directory cataloger set has
// nothing left to read and emits an SBOM containing ZERO npm packages.
//
// `.github/syft-release.yaml` switches the package.json cataloger back on, and
// the sbom-action step must actually pass it via `config:`. Dropping either half
// silently produces an empty SBOM again — which is exactly what happened on the
// v0.1.66 tag (verify-sbom-scope.mjs failed the release closed, as designed).
// That gate stays the authoritative runtime check; this test is the cheap
// static guard so the regression is caught on the PR instead of at the tag.
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

describe("release SBOM cataloger wiring", () => {
  const workflow = stripComments(read(".github/workflows/publish.yml"));
  const syftConfig = stripComments(read(".github/syft-release.yaml"));

  it("passes the syft config to the SBOM action", () => {
    expect(workflow).toContain("config: .github/syft-release.yaml");
  });

  it("scans the prod-only staging tree, not the workspace", () => {
    // A workspace scan would re-include devDependencies and fail the scope gate.
    // Regex (not toContain) so the GitHub Actions `${{ }}` expression does not
    // read as a JS template placeholder to the linter.
    expect(workflow).toMatch(/path:\s*\$\{\{\s*runner\.temp\s*\}\}\/sbom-src/);
  });

  it("enables the package.json cataloger additively", () => {
    expect(syftConfig).toContain("select-catalogers:");
    // The leading `+` is required SYNTAX, not decoration: syft's set operation
    // accepts only tags, so a bare name is rejected outright ("names are not
    // allowed with this operation"). The `+` operator is what makes the
    // expression an addition to the default cataloger set. Verified against the
    // pinned syft v1.42.3 — a bare name exits non-zero rather than replacing
    // the defaults, so this stays a fail-closed mistake, but pin it anyway.
    expect(syftConfig).toMatch(/-\s*"\+javascript-package-cataloger"/);
  });
});
