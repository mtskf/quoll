import * as assert from "node:assert";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  deferred,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

// Close-race integration tests: successful drain, stashed write refusal,
// and refusal of the preceding apply.
// Keep the backing document open to isolate settlement behavior.
// Recovery eligibility, ownership, and limits:
// ARCHITECTURE.md's surface/unsaved-draft-rescue.ts entry.
// Real untitled delivery is pinned by write-failure-rescue-on-close.test.ts.
describe("pending-edit-dispose-drain", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("drains a lock-held stashed edit to the TextDocument after the panel is disposed", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");
    const doc = panel.document;

    // Hold the backing document open in a text editor so disposing the Quoll
    // panel does not GC it (see the file-level comment) — the post-dispose
    // drain's applyEdit needs a live document to land on.
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });

    // Apply edit #1 for REAL immediately (document → "first", dirty) but hold
    // its SETTLEMENT open until the gate resolves, so the write lock stays held
    // while edit #2 arrives and the panel is disposed. Route the SECOND apply
    // (the drain) through the real workspace.applyEdit so its bytes land.
    //
    // The drain's Thenable is captured and returned AS IS — awaiting or chaining
    // it here would put a continuation between the real apply and the host and
    // could reorder the settlement this test exists to observe.
    const gate = deferred<boolean>();
    let calls = 0;
    let drainApply: Thenable<boolean> | undefined;
    harness.applyEditOverride = (edit) => {
      calls += 1;
      if (calls === 1) {
        return vscode.workspace.applyEdit(edit).then((ok) => gate.promise.then(() => ok));
      }
      drainApply = vscode.workspace.applyEdit(edit);
      return drainApply;
    };

    // Edit #1 enters the accept arm, applies for real, and holds the lock.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      editId: 1,
      content: "first",
      baseDocVersion: seed.message.docVersion,
    });
    assert.strictEqual(calls, 1, "edit #1 must acquire the write lock (applyEdit called)");

    // Let edit #1's real applyEdit land before edit #2 (also pins the re-base
    // premise: the settled document must equal edit #1's target for canDrain).
    const applied1Deadline = Date.now() + 3000;
    while (doc.getText() !== "first" && Date.now() < applied1Deadline) {
      await tick(20);
    }
    assert.strictEqual(doc.getText(), "first", "edit #1 must land on the document while in flight");

    // Edit #2 arrives WHILE the lock is held → the host stashes it (no drop).
    const drained = "[last](javascript:alert(1))\n";
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      editId: 2,
      content: drained,
      baseDocVersion: seed.message.docVersion,
    });

    // Dispose BEFORE releasing edit #1 — the race: type-one-more + close in the
    // same ms. onDidDispose sets disposed + clears the lock; the stash survives.
    panel.webviewPanel.dispose();
    await tick(50);

    // Release edit #1: its settlement fires post-dispose and drains the stash
    // through normal settlement via a real applyEdit, re-based onto "first".
    gate.resolve(true);

    const deadline = Date.now() + 3000;
    while (calls < 2 && Date.now() < deadline) {
      await tick(20);
    }
    assert.strictEqual(calls, 2, "the stashed edit must drain via a real applyEdit after dispose");

    // A call count proves neither acceptance nor completion, so wait on the
    // drain's own result instead of a settle window: a refused apply fails here
    // as a refusal, not as stale bytes two lines down.
    assert.ok(drainApply, "the drain's applyEdit Thenable must have been captured");
    assert.strictEqual(await drainApply, true, "the drain's real applyEdit must be accepted");

    assert.strictEqual(doc.getText(), drained, "stashed edit #2 bytes must reach the TextDocument");
    assert.ok(doc.isDirty, "the drained write must leave the document dirty (unsaved)");
  });

  it("rescues a stash whose apply returns false after disposal", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");
    const doc = panel.document;

    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });

    // Same setup as above: edit #1 applies for real, its settlement is gated so
    // the lock stays held and edit #2 is stashed.
    const gate = deferred<boolean>();
    let calls = 0;
    harness.applyEditOverride = (edit) => {
      calls += 1;
      if (calls === 1) {
        return vscode.workspace.applyEdit(edit).then((ok) => gate.promise.then(() => ok));
      }
      return Promise.resolve(false);
    };
    // Installed AFTER the last getHarness(): the suite-wide no-op override is
    // re-applied by getHarness().
    const rescued: string[] = [];
    harness.openRescuedDraftOverride = (content) => {
      rescued.push(content);
      return Promise.resolve();
    };

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      editId: 1,
      content: "first",
      baseDocVersion: seed.message.docVersion,
    });
    assert.strictEqual(calls, 1, "edit #1 must acquire the write lock (applyEdit called)");
    const applied1Deadline = Date.now() + 3000;
    while (doc.getText() !== "first" && Date.now() < applied1Deadline) {
      await tick(20);
    }
    assert.strictEqual(doc.getText(), "first", "edit #1 must land on the document while in flight");

    // Edit #2 is stashed; the applyEdit override will refuse its write on drain.
    const refused = `# T\n\n[bad](javascript:alert(1))\n\nRESCUE-${Math.random().toString(36).slice(2)}\n`;
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      editId: 2,
      content: refused,
      baseDocVersion: seed.message.docVersion,
    });

    panel.webviewPanel.dispose();
    await tick(50);
    // The write is still pending at close; rescue waits for drain settlement.
    assert.deepStrictEqual(rescued, [], "nothing may be rescued before the stash drains");

    gate.resolve(true);
    const deadline = Date.now() + 3000;
    while (rescued.length < 1 && Date.now() < deadline) {
      await tick(20);
    }
    assert.deepStrictEqual(rescued, [refused], "the refused stash must be reopened exactly once");
    assert.strictEqual(calls, 2, "the drain attempted the refused write");
    assert.strictEqual(doc.getText(), "first");
  });
  it("rescues the later stash when the preceding apply is refused after close", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");
    const doc = panel.document;
    const original = doc.getText();
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    });
    const gate = deferred<boolean>();
    let calls = 0;
    harness.applyEditOverride = () => {
      calls += 1;
      return gate.promise;
    };
    const rescued: string[] = [];
    harness.openRescuedDraftOverride = (content) => {
      rescued.push(content);
      return Promise.resolve();
    };
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      editId: 1,
      content: "first",
      baseDocVersion: seed.message.docVersion,
    });
    assert.strictEqual(calls, 1);
    const later = "exact later\r\nbytes!";
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      editId: 2,
      content: later,
      baseDocVersion: seed.message.docVersion,
    });
    panel.webviewPanel.dispose();
    await tick(50);
    gate.resolve(false);
    const deadline = Date.now() + 3000;
    while (rescued.length < 1 && Date.now() < deadline) {
      await tick(20);
    }
    assert.deepStrictEqual(rescued, [later]);
    assert.strictEqual(harness.lastError, null);
    assert.strictEqual(doc.getText(), original);
    assert.strictEqual(calls, 1);
  });
});
