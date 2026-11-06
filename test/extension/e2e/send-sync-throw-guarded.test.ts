import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

// A synchronous postMessage throw must stay inside the real panel's Document
// executor and leave it usable for a later ready/resync.

describe("send-sync-throw-guarded (Codex N5)", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("post: a synchronous throw on a Document post does not escape the drain (panel stays usable)", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);

    await tick(200);
    harness.clearEvents();

    // The next Document post THROWS SYNCHRONOUSLY. Unguarded: `post`'s
    // `send(message)` throws before `.then(...)`, escaping the drain so
    // `simulateInbound` throws. Guarded: the executor catches and logs.
    harness.webviewPostMessageOverride = (m) => {
      if (m.type === "document") {
        throw new Error("synchronous postMessage failure (N5 repro)");
      }
      return Promise.resolve(true);
    };

    // `ready` → postDocument → post → send throws synchronously.
    assert.doesNotThrow(() => panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" }));

    // Panel still usable: with a healthy surface, a `ready` delivers a
    // Document (the swallowed throw did not wedge the dispatch loop).
    harness.webviewPostMessageOverride = null;
    harness.clearEvents();
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    const recovered = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.ok(recovered, "panel did not recover after a guarded sync-throw on post");
  });
});
