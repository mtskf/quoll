// Machine-proves that every third-party package esbuild actually SHIPS into a
// distributed bundle (dist/extension.cjs + dist/webview/index.js) is named in
// the root NOTICE. Mirrors bundle-independence-metafile.test.ts: it builds the
// SAME production configs with metafile:true and reads byte attribution, so a
// tree-shaken-out package is (correctly) not required in NOTICE, and a newly
// bundled dependency fails CI until it is attributed.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
import { createBuildConfigs } from "../../esbuild.config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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
    const { hostConfig, webviewConfig } = createBuildConfigs({ production: true });
    const [host, webview] = await Promise.all([
      shippedPackages(hostConfig),
      shippedPackages(webviewConfig),
    ]);
    bundled = [...new Set([...host, ...webview])].sort();
    notice = readFileSync(resolve(root, "NOTICE"), "utf8");
  }, 60_000);

  it("bundles at least the known CodeMirror/Lezer set (guards against an empty metafile)", () => {
    expect(bundled).toContain("@codemirror/state");
    expect(bundled).toContain("@lezer/markdown");
    expect(bundled.length).toBeGreaterThanOrEqual(10);
  });

  it("names every shipped package in NOTICE", () => {
    const missing = bundled.filter((p) => !notice.includes(p));
    expect(missing, `NOTICE is missing bundled package(s): ${missing.join(", ")}`).toEqual([]);
  });
});
