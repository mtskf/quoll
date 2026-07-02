import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, openFixtureWithQuoll } from "./harness";
import type { DocumentMessageShape, RecordedEventShape } from "./types";

/**
 * Drives an explicit `ready` after the eager-seed Document arrives to
 * pin the host's reply path. NOTE: there are two redundant routes that
 * could produce the post-clearEvents Document — the synthetic ready
 * routed through panel.simulateInbound, OR a real webview ready arriving
 * concurrently from the eager-load. The timestamp anchor below pins
 * "a Document arrived AFTER we initiated the synthetic call", not
 * "the synthetic route specifically fired", which mirrors
 * hidden-webview-resync's same-contract caveat.
 */
describe("ready-handshake", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness(); // force activation before any test in this file runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("host replies to ready with a Document carrying content + docVersion + canWrite", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");

    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    assert.strictEqual(seed.message.type, "document");
    assert.strictEqual(typeof seed.message.content, "string");
    assert.ok(seed.message.content.includes("# Sample"));
    assert.strictEqual(typeof seed.message.docVersion, "number");
    assert.strictEqual(typeof seed.message.canWrite, "boolean");
    assert.strictEqual(seed.message.canWrite, true);

    // Now drive an explicit `ready` to pin the host's reply path
    // independent of the eager seed. Anchor the wait on a timestamp
    // captured BEFORE the synthetic call so a leaked Document from
    // the eager-seed window cannot satisfy the predicate.
    const beforeSynthetic = Date.now();
    harness.clearEvents();
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });

    const isDocAfterSynthetic = (
      e: RecordedEventShape
    ): e is RecordedEventShape & { message: DocumentMessageShape } =>
      isDocumentEvent(e) && e.timestamp >= beforeSynthetic;
    const reply = await harness.waitForEvent(isDocAfterSynthetic, 5000);
    assert.strictEqual(reply.message.docVersion, seed.message.docVersion);
    assert.ok(reply.message.content.includes("# Sample"));
  });
});
