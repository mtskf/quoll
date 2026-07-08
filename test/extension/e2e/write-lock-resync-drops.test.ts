import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  deferred,
  getHarness,
  hideQuollByOpeningOtherDoc,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

// Both arms here are only reachable while the host write lock is held
// (pendingApplyBaseVersion !== null). We hold the lock by routing the
// accept-arm applyEdit through a deferred that the test never resolves
// until teardown; while it is pending the lock stays acquired.
describe("write-lock-resync-drops", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("drops the `ready` seed while the host write lock is held", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    // Hold the lock: the accept arm calls applyEditOverride and awaits it;
    // a never-resolving deferred keeps pendingApplyBaseVersion non-null.
    const gate = deferred<boolean>();
    let overrideCalled = false;
    harness.applyEditOverride = () => {
      overrideCalled = true;
      return gate.promise;
    };

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "locked edit content",
      baseDocVersion: seed.message.docVersion,
    });

    // Vacuous-test guard: the edit must have reached the accept arm and
    // acquired the lock. If it were stale-dropped (baseDocVersion drift),
    // the lock would never be held and the ready below would post a
    // Document — a failure for the WRONG reason. Mirrors the calls>=1
    // guard in post-records-accepted-only.test.ts.
    assert.ok(overrideCalled, "edit must enter the accept arm and acquire the write lock");

    try {
      // Settle any async postMessage from the seed, then drain so the
      // assertion window only sees a (under-test) ready-arm Document. The
      // accept arm posts nothing until applyEdit settles (gate is pending),
      // so after this clear the only way a Document appears is the ready arm.
      await tick(50);
      harness.clearEvents();

      // Ready during the lock window MUST be dropped (warn + return).
      panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });

      await assert.rejects(
        harness.waitForEvent(isDocumentEvent, 1500),
        (err: Error) => /waitForEvent timed out/.test(err.message),
        "ready during the write lock must NOT post a Document"
      );
    } finally {
      // Release the lock even if the assertion throws, so the panel's
      // applyEdit.then continuation settles instead of leaking a pending
      // microtask/closure into teardown.
      gate.resolve(false);
    }
  });

  it("drops the visible-edge resync while the host write lock is held", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    // Hold the lock first (same shape as the ready-drop test above).
    const gate = deferred<boolean>();
    let overrideCalled = false;
    harness.applyEditOverride = () => {
      overrideCalled = true;
      return gate.promise;
    };

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "locked edit content",
      baseDocVersion: seed.message.docVersion,
    });
    assert.ok(overrideCalled, "edit must enter the accept arm and acquire the write lock");

    // Non-vacuity of the absence assertion below is established by the
    // review-cycle revert-check, NOT an in-test positive control: removing the
    // `pendingApplyBaseVersion` guard from the onDidChangeViewState arm reds
    // this spec (verified — RC2), and that red is ATTRIBUTABLE to the
    // visible-edge path because the `ready` arm stays guarded during the lock,
    // so only the un-guarded visible-edge path can post. An in-test positive
    // control (an unlocked hide→reveal asserting a Document appears) is
    // intentionally omitted: a hide→show Document cannot be attributed to the
    // visible-edge handler vs the `ready` re-handshake at the E2E boundary —
    // `ready` can re-issue on hide→show under retainContextWhenHidden (see the
    // `pendingRejection` rationale in quoll-editor-panel.ts), and its arm
    // also calls postDocument() when the lock is clear, so such a control would
    // be a non-attributable (misleading) canary.

    try {
      await tick(50);
      harness.clearEvents();

      // Hide then reveal to drive a genuine visibility transition. The hide
      // edge (visible=false) is ignored by the guard; the reveal edge
      // (visible=true) reaches the pendingApplyBaseVersion check.
      await hideQuollByOpeningOtherDoc();
      await tick(200);
      panel.webviewPanel.reveal();

      await assert.rejects(
        harness.waitForEvent(isDocumentEvent, 1500),
        (err: Error) => /waitForEvent timed out/.test(err.message),
        "visible-edge resync during the write lock must NOT post a Document"
      );
    } finally {
      gate.resolve(false);
    }
  });
});
