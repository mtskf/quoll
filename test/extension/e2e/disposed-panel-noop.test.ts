import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  closeAllEditors,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

// Pins the disposed-panel no-op: once onDidDispose has set disposed=true,
// handleInbound returns at its top guard, so a late inbound edit is not
// processed (override never called, no Document posted).
describe("disposed-panel-noop", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("ignores an inbound edit after the panel is disposed", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    // Capture the panel BEFORE disposing — onDidDispose nulls activePanel.
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");

    let calls = 0;
    harness.applyEditOverride = async () => {
      calls += 1;
      return true;
    };

    // Drain prior events, then dispose the panel.
    harness.clearEvents();
    await closeAllEditors();

    // Wait until onDidDispose has actually fired instead of guessing with a
    // fixed tick: onDidDispose calls setActivePanel(null, panelControls), so
    // activePanel flipping to null is the crisp disposal signal. A bare tick
    // races onDidDispose on slow machines, turning a deterministic pin into
    // a flaky one.
    const deadline = Date.now() + 2000;
    while (harness.activePanel !== null && Date.now() < deadline) {
      await tick(20);
    }
    assert.strictEqual(harness.activePanel, null, "panel must be disposed before the late edit");

    // Late inbound edit: handleInbound's top `if (disposed) return` must
    // drop it. simulateInbound routes straight into handleInbound, so this
    // reaches the exact guard under test.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "post-dispose edit",
      baseDocVersion: seed.message.docVersion,
    });
    await tick(150);

    assert.strictEqual(calls, 0, "applyEdit must NOT run for an edit after dispose");
    assert.strictEqual(
      harness.events.filter(isDocumentEvent).length,
      0,
      "no Document must be posted after dispose"
    );
  });
});
