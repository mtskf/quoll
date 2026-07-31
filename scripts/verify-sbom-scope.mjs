#!/usr/bin/env node
// scripts/verify-sbom-scope.mjs
//
// CI gate (publish.yml): assert the SPDX SBOM that gets attested against the
// published .vsix reflects ONLY the shipped runtime dependency closure —
// exact resolved versions, every declared runtime `dependency` present, a
// known shipped transitive dep present (proves the closure — not just the
// top-level manifest — was captured), and NO build-only tooling
// (devDependencies) leaking in.
//
// Why: the SBOM is generated from a prod-only staging tree (see publish.yml
// "Assemble shipped runtime dependency tree"). This gate is the mechanical
// backstop so a scoping regression — e.g. a scan reverted to `path: .` that
// re-includes devDependencies, or a degenerate bare-manifest scan that emits
// only the self-package — fails the release instead of shipping a misleading
// attestation. Fail-closed by design.
//
// Usage: node scripts/verify-sbom-scope.mjs <path-to-sbom.spdx.json>
// Exit:  0 pass, 1 scope violation, 2 usage/parse error.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// A resolved npm version must be an exact, anchored semver core. Prerelease
// (`-rc.1`) and build (`+build.5`) identifiers are allowed; ranges, wildcards,
// partials, `v`-prefixes, `latest`, and `NOASSERTION` are not — those are
// useless for CVE/VEX matching against the shipped bytes.
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/;

// npm packages in an SPDX doc carry a `pkg:npm/...` purl external ref; other
// SPDX packages (the analyzed directory / document root) do not and are skipped.
function npmPackages(sbom) {
  const out = [];
  for (const p of sbom.packages ?? []) {
    const isNpm = (p.externalRefs ?? []).some(
      (r) =>
        r.referenceType === "purl" &&
        typeof r.referenceLocator === "string" &&
        r.referenceLocator.startsWith("pkg:npm/")
    );
    if (isNpm) out.push({ name: p.name, version: p.versionInfo });
  }
  return out;
}

export function checkSbomScope({ sbom, dependencies, devDependencies, requiredTransitive }) {
  const errors = [];
  const pkgs = npmPackages(sbom);
  const names = new Set(pkgs.map((p) => p.name));

  // 1. No build-only tooling. Catches the realistic regression (scan reverted
  //    to `path: .`, which re-includes the full node_modules): the root
  //    devDependency names then appear in the SBOM.
  const leaked = Object.keys(devDependencies ?? {}).filter((d) => names.has(d));
  if (leaked.length) errors.push(`dev tooling leaked into SBOM: ${leaked.join(", ")}`);

  // 2. Every declared runtime dependency present. Catches a degenerate scan
  //    (bare manifest → only the self-package survives).
  const missingDirect = Object.keys(dependencies ?? {}).filter((d) => !names.has(d));
  if (missingDirect.length)
    errors.push(`declared runtime dependencies missing from SBOM: ${missingDirect.join(", ")}`);

  // 3. Known shipped transitive deps present — proves the SBOM captured the
  //    closure, not just top-level manifest entries.
  const missingTransitive = (requiredTransitive ?? []).filter((d) => !names.has(d));
  if (missingTransitive.length)
    errors.push(
      `known shipped transitive dependencies missing from SBOM: ${missingTransitive.join(", ")}`
    );

  // 4. Exact resolved versions only.
  const ranged = pkgs.filter((p) => !p.version || !EXACT_SEMVER.test(p.version));
  if (ranged.length)
    errors.push(
      `non-exact versions in SBOM: ${ranged.map((p) => `${p.name}@${p.version}`).join(", ")}`
    );

  return { ok: errors.length === 0, errors, npmCount: pkgs.length };
}

function main() {
  const sbomPath = process.argv[2];
  if (!sbomPath) {
    console.error("usage: node scripts/verify-sbom-scope.mjs <path-to-sbom.spdx.json>");
    process.exit(2);
  }
  let sbom;
  let pkg;
  try {
    sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
  } catch (err) {
    console.error(`verify-sbom-scope: cannot read/parse ${sbomPath}: ${err.message}`);
    process.exit(2);
  }
  try {
    pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  } catch (err) {
    console.error(`verify-sbom-scope: cannot read package.json: ${err.message}`);
    process.exit(2);
  }

  // Known shipped transitive prod deps (see NOTICE — packages whose code the
  // bundle contains but which are not direct dependencies). If the CodeMirror
  // dep tree ever drops one, NOTICE + notice-covers-bundled-deps.test.ts go
  // stale first; update all three together.
  const requiredTransitive = ["@marijn/find-cluster-break", "crelt", "style-mod", "w3c-keyname"];

  const { ok, errors, npmCount } = checkSbomScope({
    sbom,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    requiredTransitive,
  });

  if (!ok) {
    for (const e of errors) console.error(`::error::verify-sbom-scope: ${e}`);
    process.exit(1);
  }
  console.log(`verify-sbom-scope: OK — ${npmCount} npm packages, runtime-scoped, exact versions.`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
