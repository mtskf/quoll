import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, openFixtureWithQuoll } from "./harness";

describe("failed-applyedit-surfaced", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness(); // force activation before any test in this file runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("surfaces an error when applyEdit resolves false", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    harness.applyEditOverride = async () => false;

    const panel = harness.activePanel;
    assert.ok(panel);
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "new content from webview",
      baseDocVersion: seed.message.docVersion,
    });

    // Arm-specific matcher: a refactor that routes the ok=false path
    // through the rejection-arm's "Failed to save:" string still
    // showed `Failed to save` to the user but lost the false-resolve
    // contract. The narrower regex catches that drift.
    const errorMsg = await harness.waitForError(
      (msg) => /Quoll could not save .*\. Reload the file or try again\./i.test(msg),
      5000
    );
    assert.ok(errorMsg, "expected showError to fire after applyEdit(false); none received");
  });

  it("surfaces an error when applyEdit rejects", async () => {
    // Pins the panel's `.then(_, err)` arm — a rejected override
    // must flow through the same recovery path as a false resolve.
    // Without this, a future refactor could silently drop the
    // rejection branch and `failed-applyedit-surfaced` would still
    // pass on the false-resolve sub-case alone.
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    harness.applyEditOverride = async () => {
      throw new Error("synthetic-applyEdit-failure");
    };

    const panel = harness.activePanel;
    assert.ok(panel);
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "new content from webview",
      baseDocVersion: seed.message.docVersion,
    });

    // Arm-specific matcher: pin both the prefix ("Failed to save: ")
    // and the inner Error message so a swap to the false-resolve
    // arm's wording would not pass this regex.
    const errorMsg = await harness.waitForError(
      (msg) => /^Failed to save: .*synthetic-applyEdit-failure/.test(msg),
      5000
    );
    assert.ok(errorMsg);
  });

  it("clears the write lock after applyEdit failure so subsequent edits proceed", async () => {
    // Lock-leak revert-check: if QuollEditorPanel's ok=false arm
    // forgets to reset pendingApplyBaseVersion, the SECOND inbound
    // Edit silently drops at the "host write lock held" guard and
    // applyEditOverride is never re-entered. Counting override calls
    // is the cheapest panel-level pin without needing a pure-function
    // extraction (the broader lock-ordering pin lives on TODO L66 as
    // a Slice 8b follow-up).
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    let calls = 0;
    let resolveSecondCalled: (() => void) | undefined;
    const secondCalled = new Promise<void>((resolve) => {
      resolveSecondCalled = resolve;
    });
    harness.applyEditOverride = async () => {
      calls += 1;
      if (calls === 2) {
        resolveSecondCalled?.();
      }
      return calls !== 1;
    };

    const panel = harness.activePanel;
    assert.ok(panel);

    // Drain the seed (and any prior outbound events) so the post-failure
    // resync Document below is unambiguous. The previous `e.timestamp >
    // seed.timestamp` predicate was race-prone: the seed timestamp
    // (recorded at the end of resolveCustomTextEditor) and the post-
    // failure Document (recorded inside the same synchronous error arm
    // microtask) can fall on the same 1ms tick under fast CI.
    harness.clearEvents();

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "first attempt",
      baseDocVersion: seed.message.docVersion,
    });
    // Wait for the failure surface + post-failure resync Document so
    // the .then continuation has definitely run (pendingApplyBase-
    // Version cleared at this point if the lock is healthy). After
    // clearEvents() above, the next Document event is the resync.
    await harness.waitForError(() => true, 5000);
    await harness.waitForEvent(isDocumentEvent, 3000);

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "second attempt",
      baseDocVersion: seed.message.docVersion,
    });
    // Promise-based waiter: resolves the moment the panel re-enters
    // the override (`calls === 2`). A fixed sleep here masked a lock
    // leak under slow CI as a silent assertion mismatch; the
    // Promise.race surfaces the leak as "second edit never reached
    // applyEdit" with a 3s ceiling.
    await Promise.race([
      secondCalled,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("second edit never reached applyEdit — lock leaked")),
          3000
        )
      ),
    ]);
    assert.strictEqual(calls, 2, "second edit must reach applyEdit — lock leaked");
  });

  it("surfaces an error and clears the lock when applyEdit throws synchronously", async () => {
    // Distinct from the reject test above: a NON-async throwing override
    // throws at the call site (`pending = this.harness.applyEditOverride(edit)`),
    // hitting the synchronous catch (QuollEditorPanel ~L530), not the
    // `pending.then(_, err)` rejection arm. Both surface "Failed to save: ",
    // so we also assert the lock cleared (second edit reaches the override)
    // — the behaviour the synchronous catch uniquely guarantees.
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    let calls = 0;
    let resolveSecondCalled: (() => void) | undefined;
    const secondCalled = new Promise<void>((resolve) => {
      resolveSecondCalled = resolve;
    });
    // Intentionally NOT async: an async function that throws yields a
    // rejected Promise (the reject arm). A plain throwing function throws
    // synchronously at the call site (the catch arm under test). Zero-arg is
    // assignable to the field's `(edit) => Thenable<boolean>` type (TS param
    // bivariance) — same as the existing `async () => false` overrides above,
    // so no cast is needed.
    harness.applyEditOverride = () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("synthetic-sync-applyEdit-throw");
      }
      resolveSecondCalled?.();
      return Promise.resolve(true);
    };

    const panel = harness.activePanel;
    assert.ok(panel);

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "first attempt (sync throw)",
      baseDocVersion: seed.message.docVersion,
    });

    // Pin the synchronous-catch toast: same "Failed to save: " prefix as the
    // reject arm, plus the inner Error message so a swap to the resolve-false
    // wording ("Quoll could not save …") would not pass. `simulateInbound`
    // runs handleInbound synchronously, so by the time this toast fires the
    // sync catch has already executed `pendingApplyBaseVersion = null` (the
    // statement above showError in the same arm) — i.e. the lock is cleared.
    const errorMsg = await harness.waitForError(
      (msg) => /^Failed to save: .*synthetic-sync-applyEdit-throw/.test(msg),
      5000
    );
    assert.ok(errorMsg, "expected showError after a synchronous applyEdit throw");

    // Lock-cleared proof — the one contract the sync catch uniquely guarantees
    // that is observable at the integration boundary: with the lock released,
    // a SECOND edit on the same base reaches the override (calls===2). If the
    // catch had not cleared pendingApplyBaseVersion, this edit would silently
    // drop at the "host write lock held" guard and the override would never be
    // re-entered. (The catch's postDocument() resync is NOT asserted here: the
    // real webview's `ready` handshake posts Documents independently, so a
    // Document event cannot be attributed to the catch in E2E — calls===2 is
    // the attributable signal.)
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "second attempt",
      baseDocVersion: seed.message.docVersion,
    });
    await Promise.race([
      secondCalled,
      new Promise<void>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("second edit never reached applyEdit — sync-throw leaked the lock")),
          3000
        )
      ),
    ]);
    assert.strictEqual(calls, 2, "second edit must reach applyEdit — sync-throw leaked the lock");
  });
});
