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
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/extension/e2e/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      all: true,
      reporter: ["text", "json-summary"],
    },
  },
});
