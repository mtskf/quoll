import * as assert from "node:assert";
import { cleanupBetweenTests, getHarness, openFixtureWithQuoll } from "./harness";

// Pins the panel-side catch in resolveCustomTextEditor: when the webview
// HTML build throws, the panel logs, shows a toast, and returns early
// (no listeners wired, activePanel never set). webview-html.test.ts pins
// that buildWebviewHtml throws; this pins the panel's recovery from it.
describe("webview-html-build-failure", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    // Clear the override BEFORE cleanup re-opens / closes editors so a
    // teardown-time resolve does not re-trigger the throw. reset() also
    // nulls it, but that fires after closeAllEditors.
    harness.buildWebviewHtmlOverride = null;
    await cleanupBetweenTests(harness);
  });

  it("surfaces a toast and returns early when the webview HTML build throws", async () => {
    const harness = await getHarness();
    harness.buildWebviewHtmlOverride = () => {
      throw new Error("synthetic-webview-html-build-failure");
    };

    await openFixtureWithQuoll("sample.md");

    const errorMsg = await harness.waitForError(
      (msg) => /failed to initialise the editor/i.test(msg),
      5000
    );
    assert.ok(errorMsg, "expected the panel-side catch to call showError");

    // Early-return contract: the catch returns before setActivePanel, so no
    // panel is installed.
    assert.strictEqual(
      harness.activePanel,
      null,
      "panel must NOT be installed after an HTML-build failure (early return)"
    );
  });
});
