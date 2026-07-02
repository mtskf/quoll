import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

// Codex N5: a SYNCHRONOUS throw from `send(message)` (the
// `webview.postMessage` call) inside the `post` / `sendEditRejected`
// executors must not escape. This is distinct from the resolve(false) /
// rejected-Promise arms already pinned by host-rejects-edit-preserves-
// webview.test.ts: a synchronous throw happens while EVALUATING
// `send(message)`, before the `.then(...)` (and before `Promise.resolve(...)`
// can assimilate it), so the surrounding rejection handler never runs.
//
// Why E2E (not a vitest unit): the two executors are closures inside
// `resolveCustomTextEditor` that close over the live `webviewPanel` /
// `document` / `disposed` / `dispatch`. They are only reachable through the
// real panel, so the `webviewPostMessageOverride` harness seam — driving the
// real `post` / `sendEditRejected` — is the only non-vacuous reproduction.
// A re-implemented fake helper (see test/extension/post-edit-rejected.test.ts)
// would pass against unguarded production code and miss this bug entirely.

describe("send-sync-throw-guarded (Codex N5)", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("sendEditRejected: a synchronous throw on edit-rejected does not escape and the rejection is cleared via resync fallback", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;
    const draft = `${seededContent}\n`;

    // Let the real webview's ready/seed traffic settle before installing the
    // throwing override, so the override window only sees the edit we drive.
    await tick(200);
    harness.clearEvents();

    // edit-rejected delivery THROWS SYNCHRONOUSLY (not a rejected Promise);
    // every other message is accepted. Unguarded: sendEditRejected's
    // `send(message)` throws while evaluating the `Promise.resolve(...)`
    // argument, escaping the drain (so `simulateInbound` itself throws) and
    // leaving the rejection stuck pending — no `editRejectedDeliveryFailed`,
    // no resync. Guarded: the executor catches and dispatches
    // `editRejectedDeliveryFailed`, which clears the rejection and reseeds a
    // Document.
    harness.webviewPostMessageOverride = (m) => {
      if (m.type === "edit-rejected") {
        throw new Error("synchronous postMessage failure (N5 repro)");
      }
      return Promise.resolve(true);
    };

    assert.doesNotThrow(() =>
      panel.simulateInbound({
        protocol: PROTOCOL_VERSION,
        type: "edit",
        content: draft,
        baseDocVersion: seedV,
      })
    );

    // The resync fallback ships the disk Document (not the rejected draft),
    // proving the rejection was cleared rather than left stuck.
    const resync = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.notStrictEqual(
      (resync.message as { content: string }).content,
      draft,
      "fallback resync should ship the disk Document, not the rejected draft"
    );

    // And the panel is no longer stuck: a subsequent `ready` routes through
    // the NORMAL postDocument (rejection already cleared), not a draft
    // re-delivery.
    harness.webviewPostMessageOverride = null;
    harness.clearEvents();
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    const normalSeed = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.notStrictEqual(
      (normalSeed.message as { content: string }).content,
      draft,
      "ready after the sync-throw fallback re-delivered the draft — rejection left stuck"
    );
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
