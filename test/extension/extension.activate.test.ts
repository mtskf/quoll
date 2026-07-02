// Activate-branch unit test for src/extension/extension.ts.
//
// Why this exists: the `extensionMode === ExtensionMode.Test ? new
// TestHarness() : undefined` ternary has no integration-level negative
// test — every E2E test runs in Test mode by construction, so a refactor
// that drops the conditional and ships TestHarness in production would
// still pass the E2E suite. This file pins both branches at the unit
// boundary so the contract is observable to tsc-equivalent CI.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

// Mock the panel registration so we don't need a live window. The
// activate body calls `QuollEditorPanel.register(context, harness)` to
// register the custom editor provider; under vitest's vscode-stub there
// is no real `window.registerCustomEditorProvider`, so the register
// static is mocked to return a disposable directly. We assert it was
// invoked with the correct harness reference in each branch.
vi.mock("../../src/extension/QuollEditorPanel.js", () => ({
  QuollEditorPanel: {
    register: vi.fn(() => ({ dispose: () => undefined })),
    viewType: "quoll.editMarkdown",
  },
}));

import type { ExtensionContext } from "vscode";
import { activate } from "../../src/extension/extension.js";
import { QuollEditorPanel } from "../../src/extension/QuollEditorPanel.js";
import { ExtensionMode } from "../extension/vscode-stub.js";

// Cast helper: activate's real signature is ExtensionContext, but tests
// supply a structurally narrow stub (only `extensionMode` and
// `subscriptions` are read in activate's body). Routing through unknown
// keeps biome's noExplicitAny clean while making the surface mismatch
// explicit at the cast site.
function asExtensionContext(stub: {
  extensionMode: number;
  subscriptions: Array<{ dispose(): void }>;
}): ExtensionContext {
  return stub as unknown as ExtensionContext;
}

describe("activate", () => {
  it("returns undefined and allocates no harness under ExtensionMode.Production", async () => {
    const registerMock = vi.mocked(QuollEditorPanel.register);
    registerMock.mockClear();

    const ctx = asExtensionContext({
      extensionMode: ExtensionMode.Production,
      subscriptions: [],
    });
    const result = await activate(ctx);

    expect(result).toBeUndefined();
    expect(registerMock).toHaveBeenCalledTimes(1);
    // Second arg is the harness; under Production it must be undefined.
    expect(registerMock.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("returns { __test: { harness } } under ExtensionMode.Test", async () => {
    const registerMock = vi.mocked(QuollEditorPanel.register);
    registerMock.mockClear();

    const ctx = asExtensionContext({
      extensionMode: ExtensionMode.Test,
      subscriptions: [],
    });
    const result = await activate(ctx);

    expect(result).toBeDefined();
    expect(result?.__test).toBeDefined();
    expect(result?.__test?.harness).toBeDefined();
    expect(result?.__test?.harness.events).toEqual([]);
    expect(result?.__test?.harness.inboundEvents).toEqual([]);

    // The harness passed to register() must be the same instance returned
    // to the caller, so panel ↔ harness identity is preserved.
    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock.mock.calls[0]?.[1]).toBe(result?.__test?.harness);
  });
});

// Static bundle-hygiene pin. The runtime ternary above only asserts the
// Production branch returns no harness — it does NOT see the production
// `dist/extension.cjs` bundle, so an esbuild misconfiguration (e.g. the
// `external: ["./test-harness.js"]` literal in esbuild.config.mjs going
// stale against an import-path refactor) would silently inline the
// TestHarness class body into the shipped Marketplace bundle and both
// activate tests above would stay green. This describe grep'p TestHarness-
// unique identifiers (`_eventWaiters`, `recordInbound`) against the
// bundle on disk so that channel is closed at the unit-test boundary.
//
// Skipped when `dist/extension.cjs` is absent — single-shot `pnpm
// test:unit` does not depend on a prior build. The full CI path
// (`pnpm test:e2e` runs `pnpm build` first, and direct `pnpm build`
// followed by `pnpm test:unit`) always populates dist/.
describe("dist/extension.cjs bundle hygiene", () => {
  it("does not contain TestHarness class body identifiers", () => {
    const distPath = resolve(__dirname, "../../dist/extension.cjs");
    if (!existsSync(distPath)) {
      return;
    }
    const bundle = readFileSync(distPath, "utf8");
    // The three private waiter arrays are TestHarness's class-body-only
    // identifiers — they never appear at production call sites
    // (QuollEditorPanel only touches `harness.recordEvent(...)`,
    // `harness.recordInbound(...)`, etc., which esbuild preserves at
    // the call site whether or not the class body is bundled). Their
    // presence in the production bundle is a definitive signal that
    // the `external: ["./test-harness.js"]` config in esbuild.config.mjs
    // has stopped matching (an import-path refactor invalidated the
    // string-literal match).
    expect(bundle).not.toContain("_eventWaiters");
    expect(bundle).not.toContain("_inboundWaiters");
    expect(bundle).not.toContain("_errorWaiters");
  });
});
