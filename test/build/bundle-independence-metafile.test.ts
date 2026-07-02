// Machine-proves the host ⇎ webview bundle split from the esbuild METAFILE,
// closing the transitive-reachability gap that the source-level import test
// (test/webview/lint-independence.test.ts) cannot cover.
//
// The source-level test only inspects each lint file's own `import`
// statements; it cannot see a module pulled in transitively (file A imports
// allow-listed B, B imports the forbidden module). This test instead asks
// esbuild — the real bundler that builds the shipped .vsix — which modules
// actually land in each bundle, so a forbidden module reaching either bundle
// through ANY import chain fails CI.
//
// Two directions are proven:
//   - host (dist/extension.cjs)        MUST NOT contain the webview's advisory
//                                      lint engine (src/webview/cm/lint/**)
//   - webview (dist/webview/index.js)  MUST NOT contain the host-side write
//                                      gate (validate-for-write / lezer-url-walker)
//
// We build with `metafile: true, write: false` against the SAME configs the
// production build uses (imported from esbuild.config.mjs), in production mode,
// so the proven graph mirrors the .vsix exactly. Nothing is written to disk —
// the test is hermetic and does not depend on a prior `pnpm build`, which
// matters because CI runs `pnpm test:unit` BEFORE `pnpm build`.
import esbuild from "esbuild";
import { beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error — esbuild.config.mjs is plain JS with no .d.ts; the runtime
// shape (a factory returning esbuild BuildOptions) is exercised below.
import { createBuildConfigs } from "../../esbuild.config.mjs";

// Build each bundle's metafile and return the set of input module paths
// (relative to the repo root, e.g. "src/webview/cm/lint/engine.ts").
async function metafileInputs(config: esbuild.BuildOptions): Promise<string[]> {
  const result = await esbuild.build({
    ...config,
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs);
}

// Tied to the source layout. Non-anchored at the start so an absolute-path
// prefix (if esbuild ever reports one) still matches; `.ts$` pins the file.
const HOST_FORBIDDEN = /src\/webview\/cm\/lint\//;
const WEBVIEW_FORBIDDEN = /src\/markdown\/(?:validate-for-write|lezer-url-walker)\.ts$/;

describe("bundle independence (esbuild metafile)", () => {
  let hostInputs: string[];
  let webviewInputs: string[];

  beforeAll(async () => {
    const { hostConfig, webviewConfig } = createBuildConfigs({ production: true });
    [hostInputs, webviewInputs] = await Promise.all([
      metafileInputs(hostConfig),
      metafileInputs(webviewConfig),
    ]);
  }, 120_000);

  it("the host bundle contains no webview lint module", () => {
    expect(hostInputs.filter((p) => HOST_FORBIDDEN.test(p))).toEqual([]);
  });

  it("the webview bundle contains no write-gate module", () => {
    expect(webviewInputs.filter((p) => WEBVIEW_FORBIDDEN.test(p))).toEqual([]);
  });

  // Non-vacuity guard: prove each forbidden module is REAL and present on its
  // own side of the split. If a rename made the matchers above reference a
  // path that no longer exists, the exclusion checks would pass vacuously —
  // these positive assertions fail instead, forcing the matchers to be kept in
  // sync with the source layout.
  it("the forbidden modules each live on their own side of the split", () => {
    // Both arms of WEBVIEW_FORBIDDEN (validate-for-write AND lezer-url-walker)
    // must be anchored — otherwise renaming/removing one would let that arm's
    // exclusion pass vacuously. lezer-url-walker is bundled host-side
    // transitively via validate-for-write.ts.
    expect(hostInputs.some((p) => /src\/markdown\/validate-for-write\.ts$/.test(p))).toBe(true);
    expect(hostInputs.some((p) => /src\/markdown\/lezer-url-walker\.ts$/.test(p))).toBe(true);
    expect(webviewInputs.some((p) => HOST_FORBIDDEN.test(p))).toBe(true);
  });
});
