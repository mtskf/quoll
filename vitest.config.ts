import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Node environment only — the Markdown bridge (Slice 4) is pure and has no DOM.
// jsdom/happy-dom intentionally omitted; view tests (Slice 5) will add their own
// DOM shim when needed.
//
// `vscode` is only resolvable inside a live VS Code runtime; unit tests that
// exercise extension-host helpers point the import at test/extension/vscode-stub.ts
// so vitest can load the helper module without an Electron host.
export default defineConfig({
  define: { QUOLL_PERF: "false" },
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL("./test/extension/vscode-stub.ts", import.meta.url)),
    },
  },
  test: {
    // No parallelism cap by design (no maxWorkers / fileParallelism /
    // poolOptions). The "systemic full-suite load-flake" — many suites
    // intermittently failing under CPU contention — was investigated on the CI
    // runner and RULED OUT: 30/30 `pnpm test:unit` runs passed on 4-vCPU
    // ubuntu-latest (3 shards x 10 iterations). It reproduced only on an
    // overloaded dev box (load avg ~242 = ~30x oversubscription), an artifact
    // CI never hits (~4 vitest forks on 4 cores = ~1x). Capping workers here
    // would only slow every CI run to "fix" a flake that does not occur there.
    // Re-open with real CI evidence before adding a knob (a global test.retry
    // is separately forbidden — it masks real regressions). Full evidence +
    // reasoning: .claude/docs/LEARNING.md (2026-07-11 ruling-out entry).
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/extension/e2e/**", "test/webview-browser/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
    },
  },
});
