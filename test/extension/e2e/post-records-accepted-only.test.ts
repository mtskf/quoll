import * as assert from "node:assert";
import { cleanupBetweenTests, getHarness, isDocumentEvent, openFixtureWithQuoll } from "./harness";

/**
 * Regression-pin: recordEvent fires only after postMessage resolves true
 * (VS Code runtime accepted the message). If a future refactor moves
 * harness.recordEvent back to the pre-attempt position (the Slice 8a
 * default), waitForEvent below will see the seed Document immediately
 * and resolve — flipping this test from PASS to FAIL means the
 * success-arm contract has drifted. A revert-check on this test is the
 * mechanical guard for the recordEvent placement.
 */
describe("post-records-accepted-only", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    // Defensive: clear the override BEFORE cleanupBetweenTests runs
    // closeAllEditors. Without this, the cleanup's closeAllEditors path
    // could observe a still-active override if any teardown-time
    // postDocument fires. cleanupBetweenTests calls reset() which also
    // null's the override, but that fires AFTER closeAllEditors.
    harness.webviewPostMessageOverride = null;
    await cleanupBetweenTests(harness);
  });

  it("does NOT record a Document event when postMessage resolves false", async () => {
    const harness = await getHarness();
    // Override-then-open ordering rationale:
    //   `harness.webviewPostMessageOverride = ...` is a synchronous
    //   property assignment.
    //   `openFixtureWithQuoll(...)` awaits
    //   `vscode.commands.executeCommand("vscode.openWith", ...)`, which
    //   in turn triggers `QuollEditorPanel.resolveCustomTextEditor`,
    //   which posts the eager seed via the `post` helper. Because the
    //   assignment completes before the await yields, the eager seed
    //   ALWAYS reads the override field through
    //   `this.harness?.webviewPostMessageOverride` and routes through it.
    let calls = 0;
    harness.webviewPostMessageOverride = async () => {
      calls += 1;
      return false;
    };

    await openFixtureWithQuoll("sample.md");

    await assert.rejects(
      harness.waitForEvent(isDocumentEvent, 1500),
      // waitForEvent's only rejection path under serial mocha is the
      // timeout (the reject(...) inside TestHarness.waitForEvent's
      // setTimeout). reset() is called solely from
      // cleanupBetweenTests → afterEach, which cannot fire while the
      // it() body is awaiting this rejection — so the timeout matcher
      // alone pins the contract.
      (err: Error) => /waitForEvent timed out/.test(err.message),
      "Document event must NOT be recorded when postMessage resolves false"
    );
    // Vacuous-test guard: assert the override was actually invoked.
    // Without this, an override that fails to wire (e.g. plan typo on
    // the property name) would also produce a green test because the
    // real webview.postMessage would resolve true asynchronously and
    // recordEvent would fire — but waitForEvent would still have timed
    // out under the 1500 ms ceiling if the timing aligned. Asserting
    // calls >= 1 proves the override path was on.
    assert.ok(calls >= 1, `override must be called at least once; got ${calls}`);
  });

  it("does NOT record a Document event when postMessage rejects", async () => {
    const harness = await getHarness();
    let calls = 0;
    harness.webviewPostMessageOverride = async () => {
      calls += 1;
      throw new Error("synthetic-postMessage-reject");
    };

    await openFixtureWithQuoll("sample.md");

    await assert.rejects(
      harness.waitForEvent(isDocumentEvent, 1500),
      // waitForEvent's only rejection path under serial mocha is the
      // timeout (the reject(...) inside TestHarness.waitForEvent's
      // setTimeout). reset() is called solely from
      // cleanupBetweenTests → afterEach, which cannot fire while the
      // it() body is awaiting this rejection — so the timeout matcher
      // alone pins the contract.
      (err: Error) => /waitForEvent timed out/.test(err.message),
      "Document event must NOT be recorded when postMessage rejects"
    );
    assert.ok(calls >= 1, `override must be called at least once; got ${calls}`);
  });
});
