// Non-vacuity pins for scripts/verify-sbom-scope.mjs — the CI gate that keeps
// the attested SBOM scoped to the shipped runtime closure (no dev tooling,
// exact resolved versions, declared + known-transitive runtime deps present).
// @ts-nocheck — importing a plain .mjs with no bundled types; vitest runs it fine.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkSbomScope,
  deriveInstalledInventory,
  REQUIRED_TRANSITIVE,
  reconcileSbomInventory,
  resolveReconcileArg,
} from "../../scripts/verify-sbom-scope.mjs";

// Minimal SPDX-shaped npm package factory (purl external ref → npm package).
const pkg = (name, version) => ({
  name,
  versionInfo: version,
  externalRefs: [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:npm/${name}@${version}`,
    },
  ],
});

// Non-npm SPDX package: a purl external ref whose type is npm-unrelated
// (e.g. pypi). The discriminator in npmPackages() must skip it — so a
// non-exact version here must NOT trip the exact-version check.
const nonNpmPkg = (name, version, ecosystem = "pypi") => ({
  name,
  versionInfo: version,
  externalRefs: [
    {
      referenceCategory: "PACKAGE-MANAGER",
      referenceType: "purl",
      referenceLocator: `pkg:${ecosystem}/${name}@${version}`,
    },
  ],
});

const dependencies = { "@codemirror/state": "^6.6.0", "@lezer/common": "^1.5.2" };
const devDependencies = { vitest: "^3.0.0", "@types/node": "^22.0.0" };
const requiredTransitive = ["style-mod", "crelt"];

const goodPackages = [
  pkg("@codemirror/state", "6.6.0"),
  pkg("@lezer/common", "1.5.2"),
  pkg("style-mod", "4.1.3"),
  pkg("crelt", "1.0.6"),
];

const run = (packages) =>
  checkSbomScope({ sbom: { packages }, dependencies, devDependencies, requiredTransitive });

describe("checkSbomScope", () => {
  it("passes a prod-scoped SBOM", () => {
    const r = run(goodPackages);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.npmCount).toBe(4);
  });

  it("fails when dev tooling leaks in", () => {
    const r = run([...goodPackages, pkg("vitest", "3.0.5")]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/dev tooling/i);
    expect(r.errors.join(" ")).toContain("vitest");
  });

  it("fails when a declared runtime dep is missing (degenerate scan)", () => {
    // Only the self-package-style entry survived — the failure mode a bare
    // manifest scan produces.
    const r = run([pkg("@codemirror/state", "6.6.0")]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/missing/i);
    expect(r.errors.join(" ")).toContain("@lezer/common");
  });

  it("fails when a known shipped transitive dep is missing", () => {
    const r = run([
      pkg("@codemirror/state", "6.6.0"),
      pkg("@lezer/common", "1.5.2"),
      pkg("style-mod", "4.1.3"),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toContain("crelt");
  });

  it("fails on caret-range versions", () => {
    const r = run([
      pkg("@codemirror/state", "^6.6.0"),
      pkg("@lezer/common", "1.5.2"),
      pkg("style-mod", "4.1.3"),
      pkg("crelt", "1.0.6"),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/non-exact|exact/i);
    expect(r.errors.join(" ")).toContain("@codemirror/state@^6.6.0");
  });

  it.each([
    "latest",
    "1.2",
    "v1.2.3",
    "1.2.x",
    "~1.2.3",
    "*",
    "NOASSERTION",
    ">=1.0.0",
  ])("rejects non-exact version %s", (bad) => {
    const r = run([
      pkg("@codemirror/state", bad),
      pkg("@lezer/common", "1.5.2"),
      pkg("style-mod", "4.1.3"),
      pkg("crelt", "1.0.6"),
    ]);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/non-exact|exact/i);
  });

  it.each([
    "6.6.0",
    "1.2.3-rc.1",
    "1.2.3+build.5",
    "0.0.0-nightly-20240101",
  ])("accepts exact/prerelease/build version %s", (okVer) => {
    const r = run([
      pkg("@codemirror/state", okVer),
      pkg("@lezer/common", "1.5.2"),
      pkg("style-mod", "4.1.3"),
      pkg("crelt", "1.0.6"),
    ]);
    expect(r.ok).toBe(true);
  });

  it("ignores non-npm SPDX packages (no purl)", () => {
    // A real SPDX doc carries a root/document package with NOASSERTION and no
    // npm purl; it must not trip the exact-version check.
    const r = run([
      ...goodPackages,
      { name: "sbom-src", versionInfo: "NOASSERTION", externalRefs: [] },
    ]);
    expect(r.ok).toBe(true);
  });

  it("handles an empty package list as a degenerate scan", () => {
    const r = run([]);
    expect(r.ok).toBe(false);
    expect(r.npmCount).toBe(0);
  });

  it("treats a null sbom as a degenerate scan (no throw)", () => {
    // A malformed/absent SBOM (`JSON.parse("null")` → null) must fail closed,
    // not crash — the crash would bypass the CLI's exit-1 + `::error::` path.
    const call = () =>
      checkSbomScope({ sbom: null, dependencies, devDependencies, requiredTransitive });
    expect(call).not.toThrow();
    const r = call();
    expect(r.ok).toBe(false);
    expect(r.npmCount).toBe(0);
  });

  it("skips non-npm purl packages regardless of version shape", () => {
    // A pypi package with a non-exact versionInfo: the purl discriminator must
    // exclude it, so it neither counts toward npmCount nor trips the
    // exact-version check. If the `pkg:npm/` discriminator were dropped, this
    // package would be scanned as npm and its range version would fail.
    const r = run([...goodPackages, nonNpmPkg("some-pylib", ">=1.2")]);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.npmCount).toBe(4);
  });
});

// --- Shared fixtures for the --reconcile suites -----------------------------

// Build a fake prod staging tree: one real manifest per .pnpm/<dir>, deps as
// symlinks (which the adapter must skip). Mirrors pnpm's isolated layout.
function buildStaging(root, packages) {
  const dotPnpm = join(root, "node_modules", ".pnpm");
  for (const p of packages) {
    const enc = p.name.replace("/", "+");
    const innerNM = join(dotPnpm, `${enc}@${p.version}`, "node_modules");
    const leaf = join(innerNM, ...p.name.split("/"));
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, "package.json"), JSON.stringify({ name: p.name, version: p.version }));
    for (const dep of p.deps ?? []) {
      const link = join(innerNM, ...dep.split("/"));
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(dotPnpm, "target", "node_modules", ...dep.split("/")), link, "dir");
    }
  }
}

describe("resolveReconcileArg", () => {
  it("returns nulls when the flag is absent", () => {
    expect(resolveReconcileArg(["node", "s.mjs", "sbom.json"])).toEqual({
      stagingDir: null,
      error: null,
    });
  });
  it("returns the staging dir when a value follows", () => {
    const r = resolveReconcileArg(["node", "s.mjs", "sbom.json", "--reconcile", "/tmp/x"]);
    expect(r.stagingDir).toBe("/tmp/x");
    expect(r.error).toBeNull();
  });
  it("errors when --reconcile has no value (end of argv)", () => {
    const r = resolveReconcileArg(["node", "s.mjs", "sbom.json", "--reconcile"]);
    expect(r.stagingDir).toBeNull();
    expect(r.error).toMatch(/reconcile/i);
  });
  it("errors when --reconcile is followed by another flag", () => {
    const r = resolveReconcileArg(["node", "s.mjs", "sbom.json", "--reconcile", "--other"]);
    expect(r.error).toMatch(/reconcile/i);
  });
});

describe("reconcileSbomInventory", () => {
  const installed = [
    { name: "@codemirror/state", version: "6.6.0" },
    { name: "@lezer/common", version: "1.5.2" },
    { name: "crelt", version: "1.0.6" },
  ];
  const sbomOf = (pkgs) => ({ packages: pkgs });

  it("passes when the SBOM set + versions match the install exactly", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([
        pkg("@codemirror/state", "6.6.0"),
        pkg("@lezer/common", "1.5.2"),
        pkg("crelt", "1.0.6"),
      ]),
      installed,
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("fails on a syntactically-valid-but-WRONG version (the core regression)", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([
        pkg("@codemirror/state", "0.0.0"),
        pkg("@lezer/common", "1.5.2"),
        pkg("crelt", "1.0.6"),
      ]),
      installed,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/version mismatch/i);
    expect(r.errors.join(" ")).toContain("@codemirror/state");
    expect(r.errors.join(" ")).toContain("0.0.0");
    expect(r.errors.join(" ")).toContain("6.6.0");
  });

  it("fails when the SBOM carries a package not in the install (unexpected)", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([
        pkg("@codemirror/state", "6.6.0"),
        pkg("@lezer/common", "1.5.2"),
        pkg("crelt", "1.0.6"),
        pkg("evil-pkg", "9.9.9"),
      ]),
      installed,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unexpected/i);
    expect(r.errors.join(" ")).toContain("evil-pkg");
  });

  it("fails when an installed package is missing from the SBOM (degenerate scan)", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([pkg("@codemirror/state", "6.6.0"), pkg("@lezer/common", "1.5.2")]),
      installed,
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/missing from SBOM/i);
    expect(r.errors.join(" ")).toContain("crelt");
  });

  it("fails closed when the derived inventory is empty (every SBOM pkg unexpected)", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([pkg("@codemirror/state", "6.6.0")]),
      installed: [],
    });
    expect(r.ok).toBe(false);
  });

  it("skips non-npm SPDX packages (no-purl root + non-npm purl) via the npm discriminator", () => {
    // A real SPDX doc carries a no-purl document-root package and may carry
    // non-npm (e.g. pypi) entries. reconcileSbomInventory must skip both via
    // npmPackages(); otherwise they'd be misclassified as "unexpected". Pins
    // the discriminator: iterating sbom.packages directly makes this fail.
    const r = reconcileSbomInventory({
      sbom: sbomOf([
        pkg("@codemirror/state", "6.6.0"),
        pkg("@lezer/common", "1.5.2"),
        pkg("crelt", "1.0.6"),
        nonNpmPkg("some-pylib", ">=1.2"), // pypi purl → skipped
        { name: "sbom-src", versionInfo: "NOASSERTION", externalRefs: [] }, // no purl → skipped
      ]),
      installed,
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("ignores the staging self-package at its exact version — syft emits the root manifest", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([
        pkg("quoll", "0.1.65"),
        pkg("@codemirror/state", "6.6.0"),
        pkg("@lezer/common", "1.5.2"),
        pkg("crelt", "1.0.6"),
      ]),
      installed,
      ignore: ["quoll@0.1.65"],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("still flags a forged self-package at the WRONG version (exact-key ignore)", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([
        pkg("quoll", "9.9.9"),
        pkg("@codemirror/state", "6.6.0"),
        pkg("@lezer/common", "1.5.2"),
        pkg("crelt", "1.0.6"),
      ]),
      installed,
      ignore: ["quoll@0.1.65"],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unexpected/i);
    expect(r.errors.join(" ")).toContain("quoll@9.9.9");
  });

  it("dual-major overlap: surplus SBOM version is 'unexpected', not a version mismatch", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([pkg("dep", "1.0.0"), pkg("dep", "2.0.0")]),
      installed: [{ name: "dep", version: "1.0.0" }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unexpected/i);
    expect(r.errors.join(" ")).toContain("dep@2.0.0");
    expect(r.errors.join(" ")).not.toMatch(/version mismatch/i);
  });

  it("dual-major overlap: missing install version is 'missing', not a version mismatch", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([pkg("dep", "1.0.0")]),
      installed: [
        { name: "dep", version: "1.0.0" },
        { name: "dep", version: "2.0.0" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/missing from SBOM/i);
    expect(r.errors.join(" ")).toContain("dep@2.0.0");
    expect(r.errors.join(" ")).not.toMatch(/version mismatch/i);
  });

  it("fully-disjoint version sets for a name → version mismatch", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([pkg("dep", "3.0.0"), pkg("dep", "4.0.0")]),
      installed: [
        { name: "dep", version: "1.0.0" },
        { name: "dep", version: "2.0.0" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/version mismatch/i);
  });

  it("mixed boundary: a name that shares one version yet has surplus AND deficit", () => {
    const r = reconcileSbomInventory({
      sbom: sbomOf([pkg("dep", "1.0.0"), pkg("dep", "2.0.0")]),
      installed: [
        { name: "dep", version: "1.0.0" },
        { name: "dep", version: "3.0.0" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/unexpected/i);
    expect(r.errors.join(" ")).toContain("dep@2.0.0");
    expect(r.errors.join(" ")).toMatch(/missing from SBOM/i);
    expect(r.errors.join(" ")).toContain("dep@3.0.0");
    expect(r.errors.join(" ")).not.toMatch(/version mismatch/i);
  });
});

describe("deriveInstalledInventory", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sbom-fix-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads real manifests and skips symlinked deps", () => {
    buildStaging(root, [
      { name: "@codemirror/state", version: "6.6.0", deps: ["@marijn/find-cluster-break"] },
      { name: "crelt", version: "1.0.6" },
    ]);
    const inv = deriveInstalledInventory(root).sort((a, b) => a.name.localeCompare(b.name));
    expect(inv).toEqual([
      { name: "@codemirror/state", version: "6.6.0" },
      { name: "crelt", version: "1.0.6" },
    ]);
  });

  it("throws when the staging .pnpm dir is missing (fail-closed)", () => {
    expect(() => deriveInstalledInventory(join(root, "nope"))).toThrow();
  });

  it("throws when a .pnpm entry has no readable manifest (malformed)", () => {
    mkdirSync(join(root, "node_modules", ".pnpm", "broken@1.0.0", "node_modules"), {
      recursive: true,
    });
    expect(() => deriveInstalledInventory(root)).toThrow();
  });

  it("throws on invalid JSON in a manifest (fail-closed, not exit 1)", () => {
    const leaf = join(root, "node_modules", ".pnpm", "bad@1.0.0", "node_modules", "bad");
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, "package.json"), "{ not json");
    expect(() => deriveInstalledInventory(root)).toThrow();
  });

  it.each([
    ["missing name", { version: "1.0.0" }],
    ["missing version", { name: "bad" }],
    ["empty object", {}],
  ])("throws when a manifest is %s (name/version contract)", (_label, manifest) => {
    const leaf = join(root, "node_modules", ".pnpm", "bad@1.0.0", "node_modules", "bad");
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(leaf, "package.json"), JSON.stringify(manifest));
    expect(() => deriveInstalledInventory(root)).toThrow();
  });
});

describe("verify-sbom-scope CLI exit codes", () => {
  const SCRIPT = fileURLToPath(new URL("../../scripts/verify-sbom-scope.mjs", import.meta.url));
  const PKG = JSON.parse(
    readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
  );

  const runCli = (args) => {
    try {
      const stdout = execFileSync("node", [SCRIPT, ...args], { encoding: "utf8" });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  };

  // Synthetic but syntax-gate-valid inventory: every declared runtime dep +
  // every known transitive, all at exact "1.0.0". SBOM and staging are built
  // from this ONE list so they reconcile.
  const INVENTORY = [...Object.keys(PKG.dependencies ?? {}), ...REQUIRED_TRANSITIVE].map(
    (name) => ({ name, version: "1.0.0" })
  );

  const writeSbom = (file, inv) => {
    const packages = inv.map((p) => ({
      name: p.name,
      versionInfo: p.version,
      externalRefs: [{ referenceType: "purl", referenceLocator: `pkg:npm/${p.name}@${p.version}` }],
    }));
    writeFileSync(file, JSON.stringify({ packages }));
  };

  let root = "";
  let sbomPath = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sbom-cli-"));
    sbomPath = join(root, "sbom.spdx.json");
    writeSbom(sbomPath, INVENTORY);
    buildStaging(join(root, "staging"), INVENTORY);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("exit 0: default path, no flag (live-release path unchanged)", () => {
    expect(runCli([sbomPath]).code).toBe(0);
  });

  it("exit 0: --reconcile against a matching staging tree", () => {
    expect(runCli([sbomPath, "--reconcile", join(root, "staging")]).code).toBe(0);
  });

  it("exit 0: SBOM carrying the syft self-package entry still reconciles", () => {
    writeSbom(sbomPath, [{ name: PKG.name, version: PKG.version }, ...INVENTORY]);
    expect(runCli([sbomPath, "--reconcile", join(root, "staging")]).code).toBe(0);
  });

  it("exit 1: --reconcile catches a wrong-but-valid version in the SBOM", () => {
    writeSbom(sbomPath, [{ name: INVENTORY[0].name, version: "0.0.0" }, ...INVENTORY.slice(1)]);
    expect(runCli([sbomPath, "--reconcile", join(root, "staging")]).code).toBe(1);
  });

  it("exit 2: --reconcile with a missing value", () => {
    expect(runCli([sbomPath, "--reconcile"]).code).toBe(2);
  });

  it("exit 2: --reconcile against an unreadable staging dir", () => {
    expect(runCli([sbomPath, "--reconcile", join(root, "does-not-exist")]).code).toBe(2);
  });
});
