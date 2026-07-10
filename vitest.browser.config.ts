// vitest.browser.config.ts — real-chromium project for layout-dependent webview
// tests. happy-dom/jsdom have no layout engine (getBoundingClientRect → 0,
// coordsAtPos → null) AND drop var()/calc() from getComputedStyle (see memory
// quoll-happy-dom-*), so the "hang base == real computed .cm-line padding"
// contract can only be checked in a real browser. The electron E2E suite is
// host-side only. Kept SEPARATE from vitest.config.ts so the fast node/happy-dom
// unit suite is unaffected.
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
