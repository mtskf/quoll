import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, openFixtureWithQuoll } from "./harness";

/**
 * Integration coverage for `case "open-external"` in QuollEditorPanel.handleInbound.
 *
 * The unit suite (test/extension/handle-open-external.test.ts) pins
 * `handleOpenExternal` in isolation, but the case-arm's wiring — label
 * spelling, fallthrough behaviour, delegate target — has zero coverage.
 * A typo on the case label, an accidental fallthrough, or a swapped
 * delegate target would be invisible to CI. (The `Uri.parse` wrap
 * inside the production closure is intentionally NOT pinned here —
 * `openExternalOverride` replaces the entire closure, so the override
 * sees the post-allowlist href as a plain string; `QuollEditorPanel.ts`
 * documents this bypass on the case arm itself, and TypeScript's
 * `env.openExternal: (uri: Uri)` signature would catch a removed wrap
 * at compile time.)
 *
 * The harness exposes `openExternalOverride` so the test can pin the
 * delegation contract without depending on `env.openExternal` (which the
 * test process cannot spy on through the vscode module namespace). The
 * override sees the post-allowlist href as a plain string; production
 * routes through `(url) => env.openExternal(Uri.parse(url))`, but the
 * pre-Uri.parse string is exactly what `handleOpenExternal`'s injected
 * dep contract requires.
 */
describe("open-external", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness(); // force activation before any test in this file runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("invokes openExternal with the allowlisted href for a safe URL", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const calls: string[] = [];
    harness.openExternalOverride = async (url: string): Promise<boolean> => {
      calls.push(url);
      return true;
    };

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-external",
      href: "https://example.com",
    });

    // handleOpenExternal is synchronous through the gate; the override
    // resolves on the microtask queue. Two awaits flush both the `then`
    // continuation and any timer setup.
    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(
      calls,
      ["https://example.com"],
      "expected env.openExternal to be invoked once with the safe URL"
    );
  });

  it("does NOT invoke openExternal for a javascript: URL", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const calls: string[] = [];
    harness.openExternalOverride = async (url: string): Promise<boolean> => {
      calls.push(url);
      return true;
    };

    const panel = harness.activePanel;
    assert.ok(panel);
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-external",
      href: "javascript:alert(1)",
    });

    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(
      calls,
      [],
      "expected the allowlist gate to drop the javascript: URL — openExternal must not be reached"
    );
  });

  it("does NOT invoke openExternal for a fragment-only URL (allowlist-true but unlaunchable)", async () => {
    // Pins the OPENABLE_SCHEMES fallthrough at the integration boundary:
    // `#frag` passes `isAllowedUrl` (no scheme to reject) but has no
    // launchable scheme, so handleOpenExternal's second gate refuses to
    // delegate. A regression that widened OPENABLE_SCHEMES to include
    // schemeless URLs would surface here.
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const calls: string[] = [];
    harness.openExternalOverride = async (url: string): Promise<boolean> => {
      calls.push(url);
      return true;
    };

    const panel = harness.activePanel;
    assert.ok(panel);
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "open-external",
      href: "#frag",
    });

    await Promise.resolve();
    await Promise.resolve();

    assert.deepStrictEqual(
      calls,
      [],
      "expected OPENABLE_SCHEMES fallthrough to drop the fragment-only URL — openExternal must not be reached"
    );
  });
});
