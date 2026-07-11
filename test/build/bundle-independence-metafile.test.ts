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
// Three directions are proven:
//   - host (dist/extension.cjs)        MUST NOT contain the webview's advisory
//                                      lint engine (src/webview/cm/lint/**)
//   - host (dist/extension.cjs)        MUST NOT contain ANY @codemirror/* editor
//                                      module — the host URL-walker builds its
//                                      parser from pure @lezer/markdown, so the
//                                      entire CM editor stack stays webview-only
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
// (relative to the repo root, e.g. "src/webview/cm/lint/engine.ts"). This is the
// PARSE graph — every module esbuild read, INCLUDING statically-imported ones
// that tree-shaking later drops from the output (they still appear here).
async function metafileInputs(config: esbuild.BuildOptions): Promise<string[]> {
  const result = await esbuild.build({
    ...config,
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  return Object.keys(result.metafile.inputs);
}

// Build a bundle and return the map of source modules that actually SHIP bytes
// into the emitted `index.js`: `metafile.outputs[<index.js>].inputs`, keyed by
// input path with `{ bytesInOutput }`. Distinct from `metafileInputs` (the parse
// graph): a statically-imported-but-tree-shaken module is ABSENT here (or present
// with `bytesInOutput` 0). This is the real supply-chain metric — "does this
// module's code land in the shipped bundle", not "did esbuild parse it".
async function metafileShippedBytes(
  config: esbuild.BuildOptions
): Promise<Record<string, { bytesInOutput: number }>> {
  const result = await esbuild.build({
    ...config,
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const outKey = Object.keys(result.metafile.outputs).find((k) => k.endsWith("index.js"));
  if (!outKey) {
    throw new Error("webview index.js output not found in metafile");
  }
  return result.metafile.outputs[outKey].inputs;
}

// Tied to the source layout. Non-anchored at the start so an absolute-path
// prefix (if esbuild ever reports one) still matches; `.ts$` pins the file.
const HOST_FORBIDDEN = /src\/webview\/cm\/lint\//;
const WEBVIEW_FORBIDDEN = /src\/markdown\/(?:validate-for-write|lezer-url-walker)\.ts$/;
// The whole @codemirror/* editor stack must stay OUT of the host bundle: the
// URL-walker builds its parser from pure @lezer/markdown (@lezer/* only). Matches
// the pnpm virtual-store path shape
// (node_modules/.pnpm/@codemirror+view@x/node_modules/@codemirror/view/dist/…).
const HOST_CM_FORBIDDEN = /@codemirror\//;
// The nested-HTML language stack MUST NOT SHIP in the webview bundle. The editor
// language is built directly from `markdownLanguage` (see src/webview/cm/markdown.ts),
// NOT via `markdown()`, whose runtime-default `htmlTagLanguage` drags
// @codemirror/lang-html → @lezer/javascript/html/css + lang-css/lang-javascript +
// @codemirror/autocomplete (~148 KB, of which the @lezer/javascript source alone is
// ~78 KB) in. Quoll ships NO nested HTML/CSS/JS sub-language highlighting and NO
// in-editor completion today, so none of these may contribute bytes to the shipped
// bundle; a future feature that legitimately needs @codemirror/autocomplete must
// consciously relax this matcher (a reviewed decision, which is the point).
//
// NOTE the metric: this matcher is checked against SHIPPED bytes (metafileShippedBytes),
// NOT the parse graph (metafileInputs). @codemirror/lang-markdown STATICALLY imports
// @codemirror/lang-html + @codemirror/autocomplete at its module top, so importing
// markdownLanguage / markdownKeymap at all forces those modules into
// the webview's PARSE graph unavoidably — a parse-graph-absence assertion would be
// unsatisfiable. What the refactor actually delivers is that esbuild tree-shakes every
// forbidden module to `bytesInOutput` 0, so it ships nothing. That is the guarantee we
// pin. Matches the pnpm virtual-store path shape.
const WEBVIEW_HTML_STACK_FORBIDDEN =
  /@codemirror\/(?:autocomplete|lang-html|lang-css|lang-javascript)|@lezer\/(?:html|css|javascript)/;

describe("bundle independence (esbuild metafile)", () => {
  let hostInputs: string[];
  let webviewInputs: string[];
  let webviewShipped: Record<string, { bytesInOutput: number }>;

  beforeAll(async () => {
    const { hostConfig, webviewConfig } = createBuildConfigs({ production: true });
    [hostInputs, webviewInputs, webviewShipped] = await Promise.all([
      metafileInputs(hostConfig),
      metafileInputs(webviewConfig),
      metafileShippedBytes(webviewConfig),
    ]);
  }, 120_000);

  it("the host bundle contains no webview lint module", () => {
    expect(hostInputs.filter((p) => HOST_FORBIDDEN.test(p))).toEqual([]);
  });

  it("the webview bundle contains no write-gate module", () => {
    expect(webviewInputs.filter((p) => WEBVIEW_FORBIDDEN.test(p))).toEqual([]);
  });

  it("the webview bundle SHIPS no bytes from the nested-HTML language stack", () => {
    // Assert against SHIPPED bytes, not the parse graph (see the matcher comment):
    // every forbidden module must be tree-shaken to bytesInOutput 0. Before the
    // refactor these shipped ~148 KB; after building the editor language directly
    // (no markdown() wrapper, no parseCode) they contribute nothing.
    const shipped = Object.entries(webviewShipped)
      .filter(([p, v]) => WEBVIEW_HTML_STACK_FORBIDDEN.test(p) && v.bytesInOutput > 0)
      .map(([p]) => p);
    expect(shipped).toEqual([]);
  });

  it("the host bundle contains no @codemirror editor-stack module", () => {
    expect(hostInputs.filter((p) => HOST_CM_FORBIDDEN.test(p))).toEqual([]);
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
    // @codemirror/* is REAL and legitimately bundled webview-side (the editor
    // runs there). Without this, the host @codemirror exclusion above could
    // pass vacuously if HOST_CM_FORBIDDEN matched nothing anywhere.
    expect(webviewInputs.some((p) => HOST_CM_FORBIDDEN.test(p))).toBe(true);
  });

  // Non-vacuity for WEBVIEW_HTML_STACK_FORBIDDEN: the stack ships zero bytes in
  // BOTH bundles, so we cannot prove it "real" on the other side. Instead prove
  // (a) the matcher fires on representative module paths (guards a typo'd regex),
  // and (b) the shipped-bytes map is real and DISTINGUISHES shipped from
  // tree-shaken — by asserting the RETAINED markdown stack DOES ship bytes. Without
  // (b), the exclusion above could pass vacuously against an empty/mis-keyed map.
  it("the HTML-stack matcher is well-formed and the retained markdown stack SHIPS bytes webview-side", () => {
    for (const sample of [
      "node_modules/.pnpm/@codemirror+lang-html@6.4.9/node_modules/@codemirror/lang-html/dist/index.js",
      "node_modules/.pnpm/@lezer+javascript@1.5.1/node_modules/@lezer/javascript/dist/index.js",
      "node_modules/.pnpm/@codemirror+autocomplete@6.18.6/node_modules/@codemirror/autocomplete/dist/index.js",
    ]) {
      expect(WEBVIEW_HTML_STACK_FORBIDDEN.test(sample)).toBe(true);
    }
    // The editor language (markdownLanguage/markdownKeymap) + lint
    // parser still come from these, so they MUST ship real bytes — proving the
    // shipped-bytes metric reads live data and the exclusion is not vacuous.
    const shipsBytes = (re: RegExp) =>
      Object.entries(webviewShipped).some(([p, v]) => re.test(p) && v.bytesInOutput > 0);
    expect(shipsBytes(/@codemirror\/lang-markdown\//)).toBe(true);
    expect(shipsBytes(/@lezer\/markdown\//)).toBe(true);
  });
});
