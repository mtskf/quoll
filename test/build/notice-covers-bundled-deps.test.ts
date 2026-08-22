// Machine-proves that every third-party package esbuild actually SHIPS into a
// distributed bundle is named in the root NOTICE. It builds EVERY production
// config createBuildConfigs emits — host (dist/extension.cjs), webview
// (dist/webview/index.js), AND the test-harness sidecar (dist/test-harness.js),
// all re-included by .vscodeignore's `dist/**` and shipped in the .vsix — with
// metafile:true and reads byte attribution. So a tree-shaken-out package is
// (correctly) not required in NOTICE, and a newly bundled dependency (in any of
// those outputs) fails CI until it is attributed. Mirrors the metafile pattern
// of bundle-independence-metafile.test.ts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — esbuild.config.mjs is plain JS with no .d.ts; the runtime
// shape (a factory returning esbuild BuildOptions) is exercised below.
import { createBuildConfigs } from "../../esbuild.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pkgOf(inputPath: string): string | null {
  const marker = "node_modules/";
  const i = inputPath.lastIndexOf(marker);
  if (i < 0) {
    return null;
  }
  const rest = inputPath.slice(i + marker.length);
  const m = rest.match(/^(@[^/]+\/[^/]+|[^/]+)/);
  return m ? m[1] : null;
}

async function shippedPackages(config: esbuild.BuildOptions): Promise<Set<string>> {
  const result = await esbuild.build({
    ...config,
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const pkgs = new Set<string>();
  for (const out of Object.values(result.metafile!.outputs)) {
    for (const [input, meta] of Object.entries(out.inputs)) {
      if (meta.bytesInOutput > 0) {
        const p = pkgOf(input);
        if (p) {
          pkgs.add(p);
        }
      }
    }
  }
  return pkgs;
}

describe("NOTICE covers every bundled third-party package", () => {
  let bundled: string[];
  let notice: string;

  beforeAll(async () => {
    // Every value is a config emitting into the packaged dist/ (host, webview,
    // test-harness). Union them all so a dependency bundled into ANY shipped
    // output must be attributed — not just host + webview.
    // A CAST, deliberately — not a checked declaration. createBuildConfigs comes
    // from the untyped .mjs above, so Object.values() over it widens each entry
    // to `unknown`, which `.map(shippedPackages)` rejects; the cast is what
    // narrows it to the shape esbuild.build actually requires. But it only
    // ASSERTS that shape — nothing here verifies the factory really emits it.
    // Written as an annotation it would READ like a compile-time pin while doing
    // exactly this much: contextual typing feeds the annotation back into
    // Object.values<T>, and `any` satisfies whatever T it picks. Spelled as a
    // cast so the file does not claim a check it is not performing. Giving
    // esbuild.config.mjs a companion .d.mts (tracked in TODO.md) is what turns
    // this back into a real pin.
    const configs = Object.values(
      createBuildConfigs({ production: true })
    ) as esbuild.BuildOptions[];
    const sets = await Promise.all(configs.map(shippedPackages));
    bundled = [...new Set(sets.flatMap((s) => [...s]))].sort();
    notice = readFileSync(resolve(root, "NOTICE"), "utf8");
  }, 60_000);

  it("bundles at least the known CodeMirror/Lezer set (guards against an empty metafile)", () => {
    expect(bundled).toContain("@codemirror/state");
    expect(bundled).toContain("@lezer/markdown");
    expect(bundled.length).toBeGreaterThanOrEqual(10);
  });

  it("names every shipped package in NOTICE", () => {
    // Word-bounded match, NOT a bare substring: `notice.includes("state")`
    // false-passes on the "state" inside "@codemirror/state", so a future
    // package literally named `state` could ship unattributed yet still match.
    // Require the name delimited by whitespace / line boundaries so only a real
    // NOTICE entry counts.
    const missing = bundled.filter(
      (p) => !new RegExp(String.raw`(^|\s)${escapeRegExp(p)}(\s|$)`, "m").test(notice)
    );
    expect(missing, `NOTICE is missing bundled package(s): ${missing.join(", ")}`).toEqual([]);
  });
});
