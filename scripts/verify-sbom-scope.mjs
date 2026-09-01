#!/usr/bin/env node
// scripts/verify-sbom-scope.mjs
//
// CI gate (publish.yml and ci.yml's `sbom` job): assert the SPDX SBOM that
// gets attested against the published .vsix reflects ONLY the shipped
// runtime dependency closure — exact resolved versions, every declared
// runtime `dependency` present, a known shipped transitive dep present
// (proves the closure — not just the top-level manifest — was captured),
// and NO build-only tooling (devDependencies) leaking in.
//
// Why: the SBOM is generated from a prod-only staging tree (see publish.yml
// "Assemble shipped runtime dependency tree"). This gate is the mechanical
// backstop so a scoping regression — e.g. a scan reverted to `path: .` that
// re-includes devDependencies, or a degenerate bare-manifest scan that emits
// only the self-package — fails the release instead of shipping a misleading
// attestation. Fail-closed by design.
//
// Usage: node scripts/verify-sbom-scope.mjs <path-to-sbom.spdx.json> [--reconcile <stagingDir>]
// Exit:  0 pass, 1 scope violation or reconcile diff, 2 usage/parse error
//        (incl. a staging tree the inventory cannot be derived from).
//
// The optional `--reconcile <stagingDir>` flag additionally reconciles the
// SBOM's {name, version} set against an independent inventory read from the
// frozen prod staging tree's REAL package manifests (see deriveInstalledInventory),
// so a syntactically-valid-but-wrong SBOM — a stale or forged version, a package
// syft failed to catalog — fails instead of being attested.
// It is opt-in at the CLI but GATING in CI: publish.yml and ci.yml's `sbom` job
// both pass it on the verify step. It ran as a non-gating shadow step from
// 2026-08-01 and was promoted on 2026-08-21, once the v0.1.66 re-tag run logged
// `reconciled 23 staged packages against SBOM` on a real staging tree with the
// pinned syft. Absent the flag, behaviour is unchanged.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
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
  for (const p of sbom?.packages ?? []) {
    const isNpm = (p.externalRefs ?? []).some(
      (r) =>
        r.referenceType === "purl" &&
        typeof r.referenceLocator === "string" &&
        r.referenceLocator.startsWith("pkg:npm/")
    );
    if (isNpm) {
      out.push({ name: p.name, version: p.versionInfo });
    }
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
  if (leaked.length) {
    errors.push(`dev tooling leaked into SBOM: ${leaked.join(", ")}`);
  }

  // 2. Every declared runtime dependency present. Catches a degenerate scan
  //    (bare manifest → only the self-package survives).
  const missingDirect = Object.keys(dependencies ?? {}).filter((d) => !names.has(d));
  if (missingDirect.length) {
    errors.push(`declared runtime dependencies missing from SBOM: ${missingDirect.join(", ")}`);
  }

  // 3. Known shipped transitive deps present — proves the SBOM captured the
  //    closure, not just top-level manifest entries.
  const missingTransitive = (requiredTransitive ?? []).filter((d) => !names.has(d));
  if (missingTransitive.length) {
    errors.push(
      `known shipped transitive dependencies missing from SBOM: ${missingTransitive.join(", ")}`
    );
  }

  // 4. Exact resolved versions only.
  const ranged = pkgs.filter((p) => !p.version || !EXACT_SEMVER.test(p.version));
  if (ranged.length) {
    errors.push(
      `non-exact versions in SBOM: ${ranged.map((p) => `${p.name}@${p.version}`).join(", ")}`
    );
  }

  return { ok: errors.length === 0, errors, npmCount: pkgs.length };
}

// Known shipped transitive prod deps (see NOTICE — packages whose code the
// bundle contains but which are not direct dependencies). If the CodeMirror
// dep tree ever drops one, NOTICE + notice-covers-bundled-deps.test.ts go
// stale first; update all three together.
export const REQUIRED_TRANSITIVE = [
  "@marijn/find-cluster-break",
  "crelt",
  "style-mod",
  "w3c-keyname",
];

// Parse the optional `--reconcile <stagingDir>` flag. Pure (no fs/exit) so the
// missing-value branch is unit-testable; main() maps `error` to exit 2.
export function resolveReconcileArg(argv) {
  const i = argv.indexOf("--reconcile");
  if (i === -1) {
    return { stagingDir: null, error: null };
  }
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) {
    return { stagingDir: null, error: "--reconcile requires a <stagingDir> path" };
  }
  return { stagingDir: value, error: null };
}

// Strict reconciliation (via main()'s --reconcile): the SBOM's npm {name,
// version} set must EQUAL the inventory read from the staged install's real
// package manifests, after dropping `ignore` (exact `name@version` keys —
// the staging self-package, which syft catalogs from the root manifest but is
// never in .pnpm) from both sides. Compared per name on the SET of versions so
// a co-installed dual-major is classified correctly: a version on one side only
// is unexpected/missing; a name whose version sets are FULLY DISJOINT is
// surfaced as the legible "version mismatch". Catches syntactically-valid-but-
// wrong versions and any set drift the syntax-only checkSbomScope() passes.
export function reconcileSbomInventory({ sbom, installed, ignore }) {
  const ignoreKeys = new Set(ignore ?? []);
  const key = (p) => `${p.name}@${p.version}`;
  const versionsByName = (pkgs) => {
    const m = new Map();
    for (const p of pkgs) {
      if (ignoreKeys.has(key(p))) {
        continue; // drop self-package at its exact version
      }
      if (!m.has(p.name)) {
        m.set(p.name, new Set());
      }
      m.get(p.name).add(p.version);
    }
    return m;
  };
  const inst = versionsByName(installed ?? []);
  const sb = versionsByName(npmPackages(sbom));

  const errors = [];
  for (const name of new Set([...inst.keys(), ...sb.keys()])) {
    const iv = inst.get(name) ?? new Set();
    const sv = sb.get(name) ?? new Set();
    const surplus = [...sv].filter((v) => !iv.has(v)); // in SBOM, not installed
    const deficit = [...iv].filter((v) => !sv.has(v)); // installed, not in SBOM
    if (surplus.length === 0 && deficit.length === 0) {
      continue;
    }
    const shareAVersion = [...sv].some((v) => iv.has(v));
    if (!shareAVersion && surplus.length && deficit.length) {
      errors.push(
        `version mismatch for ${name}: SBOM has ${[...sv].sort().join(", ")}, ` +
          `staged install has ${[...iv].sort().join(", ")}`
      );
    } else {
      for (const v of surplus) {
        errors.push(`package in SBOM but not in staged install (unexpected): ${name}@${v}`);
      }
      for (const v of deficit) {
        errors.push(`package in staged install but missing from SBOM: ${name}@${v}`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// The real (non-symlink) leaf package dirs inside one .pnpm/<dir>/node_modules:
// pnpm hard-links a package's own files here and symlinks its deps, so the real
// leaf is the package itself. Scoped names add one "@scope" dir level.
function realLeafManifestDirs(innerNM) {
  const leaves = [];
  for (const e of readdirSync(innerNM, { withFileTypes: true })) {
    if (e.name === ".bin" || e.isSymbolicLink() || !e.isDirectory()) {
      continue;
    }
    if (e.name.startsWith("@")) {
      const scopeDir = path.join(innerNM, e.name);
      for (const g of readdirSync(scopeDir, { withFileTypes: true })) {
        if (g.isSymbolicLink() || !g.isDirectory()) {
          continue;
        }
        leaves.push(path.join(scopeDir, g.name));
      }
    } else {
      leaves.push(path.join(innerNM, e.name));
    }
  }
  return leaves;
}

// fs adapter: derive the expected {name, version} inventory of the frozen prod
// staging tree from its installed package MANIFESTS (not the pnpm dir-name
// encoding — that is not a stable contract). This is the independent second
// source reconciled against the SBOM. Fail-closed: throws on an unreadable
// .pnpm, any .pnpm/<dir> with no readable manifest, or a manifest missing
// name/version — so main() exits 2 rather than silently passing a partial
// inventory.
export function deriveInstalledInventory(stagingDir) {
  const dotPnpm = path.join(stagingDir, "node_modules", ".pnpm");
  const inventory = [];
  for (const d of readdirSync(dotPnpm, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "node_modules") {
      continue;
    }
    const innerNM = path.join(dotPnpm, d.name, "node_modules");
    const leaves = realLeafManifestDirs(innerNM);
    if (leaves.length === 0) {
      throw new Error(`verify-sbom-scope: no package manifest under ${innerNM}`);
    }
    for (const leaf of leaves) {
      // JSON.parse throws on invalid JSON (→ exit 2). A well-formed manifest
      // missing name/version would otherwise yield {undefined, undefined} and
      // slip through as an exit-1 reconcile diff — validate to keep the adapter
      // contract fail-closed.
      const manifest = JSON.parse(readFileSync(path.join(leaf, "package.json"), "utf8"));
      if (
        typeof manifest.name !== "string" ||
        !manifest.name ||
        typeof manifest.version !== "string" ||
        !manifest.version
      ) {
        throw new Error(`verify-sbom-scope: manifest missing name/version at ${leaf}`);
      }
      inventory.push({ name: manifest.name, version: manifest.version });
    }
  }
  return inventory;
}

function main() {
  const sbomPath = process.argv[2];
  if (!sbomPath) {
    console.error(
      "usage: node scripts/verify-sbom-scope.mjs <path-to-sbom.spdx.json> [--reconcile <stagingDir>]"
    );
    process.exit(2);
  }
  // Resolve the optional --reconcile flag up front so a missing value fails
  // fast (exit 2) before any file read.
  const { stagingDir, error: argError } = resolveReconcileArg(process.argv);
  if (argError) {
    console.error(`verify-sbom-scope: ${argError}`);
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

  const { ok, errors, npmCount } = checkSbomScope({
    sbom,
    dependencies: pkg.dependencies,
    devDependencies: pkg.devDependencies,
    requiredTransitive: REQUIRED_TRANSITIVE,
  });

  if (!ok) {
    for (const e of errors) {
      console.error(`::error::verify-sbom-scope: ${e}`);
    }
    process.exit(1);
  }

  // Opt-in strict reconciliation against the staged install (runs only after
  // the syntax gate passes).
  if (stagingDir) {
    let installed;
    try {
      installed = deriveInstalledInventory(stagingDir);
    } catch (err) {
      console.error(
        `::error::verify-sbom-scope: cannot read staged install at ${stagingDir}: ${err.message}`
      );
      process.exit(2);
    }
    // Exclude the staging self-package at its EXACT resolved version: syft
    // catalogs the staging-root manifest (pkg.name@pkg.version), never present
    // in .pnpm. Excluding by exact key (not bare name) keeps a forged self
    // entry at any other version flagged.
    const rec = reconcileSbomInventory({
      sbom,
      installed,
      ignore: [`${pkg.name}@${pkg.version}`],
    });
    if (!rec.ok) {
      for (const e of rec.errors) {
        console.error(`::error::verify-sbom-scope: ${e}`);
      }
      process.exit(1);
    }
    console.log(`verify-sbom-scope: reconciled ${installed.length} staged packages against SBOM.`);
  }

  console.log(`verify-sbom-scope: OK — ${npmCount} npm packages, runtime-scoped, exact versions.`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
