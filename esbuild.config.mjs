// Unified esbuild pipeline for the extension host and the new webview.
//
// Produces two bundles under dist/:
//   - dist/extension.cjs       — extension host (Node, CJS, vscode external)
//   - dist/webview/index.js    — webview entry (browser, ESM)
//   - dist/webview/index.css   — extracted CSS imported from the webview entry
//
// Host stays CJS at `dist/extension.cjs` so the `.cjs` extension makes the
// format explicit and the root `"type": "module"` (Slice 7C) does not cause
// Node/VS Code to misinterpret it as ESM. Never emit CJS as
// `dist/extension.js` under root ESM — the loader resolution will break.
//
// The webview bundle is consumed by `src/extension/webview-assets.ts`
// (Uri.joinPath(extensionUri, "dist", "webview", "index.{js,css}")).
//
// The three build configs are produced by the exported `createBuildConfigs`
// factory so a test can consume the SAME module graph the shipped .vsix is
// built from (see test/build/bundle-independence-metafile.test.ts, which runs
// esbuild with `metafile: true` against these configs to machine-prove the
// host ⇎ webview bundle split). The `run()` driver below is only invoked when
// this file is executed as a CLI entry — importing the module never triggers a
// build.

import esbuild from "esbuild";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build the three esbuild configs for a given mode. `production` toggles
// minify/sourcemap and the dev-only perf instrumentation flag; it does NOT
// change which modules land in each bundle (the import graph is identical),
// so the metafile bundle-independence test can build in production mode to
// mirror the shipped .vsix exactly.
export function createBuildConfigs({ production }) {
  // Build-time flag for the dev-only perf instrumentation (src/shared/perf.ts).
  // false in production builds → esbuild folds every `if (QUOLL_PERF)` to
  // `if (false)` and dead-codes it, so the packaged .vsix carries no
  // `[quoll][perf]` output and tree-shakes the perf module away.
  const perfDefine = { QUOLL_PERF: JSON.stringify(!production) };

  const shared = {
    bundle: true,
    sourcemap: !production,
    minify: production,
    logLevel: "info",
  };

  // `./test-harness.js` is externalised so the class body does not land in
  // `dist/extension.cjs`. The dynamic `await import("./test-harness.js")`
  // inside activate (Test mode only) resolves to the sibling
  // `dist/test-harness.cjs` at runtime; production paths never traverse
  // that branch. Without this, esbuild's CJS bundle inlines the dynamic
  // import as a lazy wrapper that still contains the ~250 LOC of waiter
  // machinery — defeating the Test-mode gate's bundle-surface intent.
  const hostConfig = {
    ...shared,
    entryPoints: [resolve(__dirname, "src/extension/extension.ts")],
    outfile: resolve(__dirname, "dist/extension.cjs"),
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode", "./test-harness.js"],
    define: { ...perfDefine },
  };

  // Test-harness sidecar bundle. Built unconditionally because the gate
  // is at activation time (extensionMode === Test) not at packaging time:
  // the file ships in `dist/` but the production code never `require`s it.
  // .vscodeignore (Slice 7C) keeps the file in the .vsix; the production
  // branch in activate never reaches the dynamic import.
  //
  // Emitted at `dist/test-harness.js` (not `.cjs`) so the dynamic
  // `await import("./test-harness.js")` inside extension.ts resolves
  // 1:1 against the on-disk filename. The repo root `"type": "module"`
  // (Slice 7C) would otherwise make `.js` ESM, so `writePlainCjsMarker`
  // below writes a sibling `dist/package.json` of `{"type":"commonjs"}`
  // to mark the dist tree as CJS. The host bundle stays at `.cjs` so
  // its file extension is self-describing; the test-harness needs a
  // matching name for the import call site.
  const testHarnessConfig = {
    ...shared,
    entryPoints: [resolve(__dirname, "src/extension/test-harness.ts")],
    outfile: resolve(__dirname, "dist/test-harness.js"),
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
  };

  const webviewConfig = {
    ...shared,
    entryPoints: [resolve(__dirname, "src/webview/index.ts")],
    outdir: resolve(__dirname, "dist/webview"),
    entryNames: "index",
    assetNames: "assets/[name]-[hash]",
    platform: "browser",
    format: "esm",
    target: ["es2022", "chrome120", "safari17"],
    jsx: "automatic",
    // @lezer/lr (bundled into @codemirror/* packages) checks
    //   `typeof process != "undefined" && process.env && /\bparse\b/.test(process.env.LOG)`
    // at runtime to enable parse debug logging. The webview runs in a browser
    // sandbox with no Node globals. We stub out the three Node globals that
    // appear in the bundle so esbuild can dead-code-eliminate the LOG guard:
    //   "process"         → "undefined"  eliminates `typeof process != "undefined"`
    //   "process.env"     → "{}"         safety net for any other process.env access
    //   "process.env.NODE_ENV" → "..."   conventional build-mode flag (no consumer
    //                                    currently needs it after PM removal, but
    //                                    kept as belt-and-suspenders)
    // esbuild resolves defines most-specific-first, so all three coexist safely.
    define: {
      ...perfDefine,
      "process": "undefined",
      "process.env": "{}",
      "process.env.NODE_ENV": JSON.stringify(production ? "production" : "development"),
    },
    loader: {
      ".woff": "file",
      ".woff2": "file",
      ".ttf": "file",
      ".otf": "file",
      ".eot": "file",
      ".svg": "file",
      ".png": "file",
      ".jpg": "file",
      ".jpeg": "file",
      ".gif": "file",
    },
  };

  return { hostConfig, webviewConfig, testHarnessConfig };
}

// dist/ ships CJS bundles but lives under the repo root "type": "module".
// Writing a sibling package.json marks the dist subtree as CJS so Node
// (and the activate dynamic-import) resolves dist/test-harness.js as CJS
// regardless of its `.js` extension.
function writeDistCjsMarker() {
  const distDir = resolve(__dirname, "dist");
  mkdirSync(distDir, { recursive: true });
  writeFileSync(resolve(distDir, "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");
}

async function run() {
  const args = new Set(process.argv.slice(2));
  const isWatch = args.has("--watch");
  const isProduction = args.has("--production");
  const { hostConfig, webviewConfig, testHarnessConfig } = createBuildConfigs({
    production: isProduction,
  });

  // Clean dist/ before every build so a rebuild never inherits stale
  // artifacts from a prior watch/dev build. Dev builds emit sourcemaps
  // (`sourcemap: !production`) that a production rebuild does NOT delete;
  // left behind, those `dist/**/*.map` files ship through .vscodeignore's
  // `!dist/**` re-include — exactly what the audit-vsix allowlist
  // (`.(cjs|js|css|json)` only) exists to refuse. The package-script audit
  // gate is the backstop; this removes the artifacts at the source.
  rmSync(resolve(__dirname, "dist"), { recursive: true, force: true });

  if (isWatch) {
    let hostCtx, webviewCtx, testHarnessCtx;
    try {
      [hostCtx, webviewCtx, testHarnessCtx] = await Promise.all([
        esbuild.context(hostConfig),
        esbuild.context(webviewConfig),
        esbuild.context(testHarnessConfig),
      ]);
      writeDistCjsMarker();
      await Promise.all([hostCtx.watch(), webviewCtx.watch(), testHarnessCtx.watch()]);
      console.log("[esbuild] watching host + webview + test-harness…");
    } catch (err) {
      await Promise.allSettled([
        hostCtx?.dispose(),
        webviewCtx?.dispose(),
        testHarnessCtx?.dispose(),
      ]);
      throw err; // re-throw so the outer .catch handles exit(1)
    }
  } else {
    await Promise.all([
      esbuild.build(hostConfig),
      esbuild.build(webviewConfig),
      esbuild.build(testHarnessConfig),
    ]);
    writeDistCjsMarker();
    console.log("[esbuild] built dist/extension.cjs + dist/webview/ + dist/test-harness.js");
  }
}

// Only drive a real build when executed as a CLI entry (`node esbuild.config.mjs`).
// Importing the module (e.g. from the metafile test) must NOT trigger a build.
const isEntry =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntry) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
