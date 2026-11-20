// vitest.browser.config.ts — real-chromium project for layout-dependent webview
// tests. happy-dom/jsdom have no layout engine (getBoundingClientRect → 0,
// coordsAtPos → null) AND drop var()/calc() from getComputedStyle (see memory
// quoll-happy-dom-*), so the "hang base == real computed .cm-line padding"
// contract can only be checked in a real browser. The electron E2E suite is
// host-side only. Kept SEPARATE from vitest.config.ts so the fast node/happy-dom
// unit suite is unaffected.

import { playwright } from "@vitest/browser-playwright";
import esbuild from "esbuild";
import { defineConfig } from "vitest/config";
// @ts-expect-error — the production build factory is an untyped JS module.
import { createBuildConfigs } from "./esbuild.config.mjs";

// Vitest loads this config for both its runner and browser servers.
// Share the in-memory build across those separate config module instances.
const buildCache = globalThis as typeof globalThis & {
  __quollProductionPasteBuild?: ReturnType<typeof esbuild.build>;
};

export default defineConfig({
  plugins: [
    {
      name: "quoll-production-paste-assets",
      async configureServer(server) {
        const { webviewConfig } = createBuildConfigs({ production: true });
        buildCache.__quollProductionPasteBuild ??= esbuild.build({
          ...webviewConfig,
          write: false,
        });
        const { outputFiles } = await buildCache.__quollProductionPasteBuild;
        if (!outputFiles) {
          throw new Error("Production build emitted no assets");
        }
        const assets = new Map(
          outputFiles.map((file) => [
            `/__quoll-production/${file.path.endsWith(".css") ? "index.css" : "index.js"}`,
            file,
          ])
        );
        server.middlewares.use((req, res, next) => {
          const asset = assets.get(req.url ?? "");
          if (!asset) {
            return next();
          }
          res.setHeader(
            "Content-Type",
            asset.path.endsWith(".css") ? "text/css" : "text/javascript"
          );
          res.end(asset.contents);
        });
      },
    },
    {
      // Records which resources the page requested, so a test can assert that
      // a parse issued none. Recorded on arrival (request start, not completion).
      // The Map is closure-local, so the recorder and the reader share one
      // instance even though vitest loads this module more than once.
      name: "quoll-request-probe",
      configureServer(server) {
        const log = new Map<string, string[]>();
        server.middlewares.use((req, res, next) => {
          const record = /^\/__quoll-probe\/([^/]+)\/([^/?]+)/.exec(req.url ?? "");
          if (record) {
            const [, nonce, name] = record;
            log.set(nonce, [...(log.get(nonce) ?? []), name]);
            res.setHeader("Content-Type", "image/png");
            res.end();
            return;
          }
          const read = /^\/__quoll-probe-log\/([^/?]+)/.exec(req.url ?? "");
          if (read) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(log.get(read[1]) ?? []));
            return;
          }
          next();
        });
      },
    },
  ],
  define: { QUOLL_PERF: "false" },
  test: {
    include: ["test/webview-browser/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});
