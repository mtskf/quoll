// Non-vacuity pins for scripts/verify-sbom-scope.mjs — the CI gate that keeps
// the attested SBOM scoped to the shipped runtime closure (no dev tooling,
// exact resolved versions, declared + known-transitive runtime deps present).
// @ts-nocheck — importing a plain .mjs with no bundled types; vitest runs it fine.
import { describe, expect, it } from "vitest";
import { checkSbomScope } from "../../scripts/verify-sbom-scope.mjs";

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
