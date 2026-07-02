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

// Sub-ms in-flight-apply + dispose data-loss race (follow-up to #224's teardown
// flush). An Edit is applying (host write lock held) when a SECOND edit arrives,
// then the panel is disposed within the same turn. The second edit must still
// reach the TextDocument: the host stashes it under the lock and drains it on
// the first apply's settlement — which fires AFTER onDidDispose — re-running the
// FULL decideEdit / validateMarkdownForWrite gates (no bypass), re-based onto
// edit #1's applied result.
//
// The document is held open in a plain text editor alongside Quoll. Why: the
// drain writes via `workspace.applyEdit`, which is a no-op on a CLOSED
// TextDocument. Disposing the SOLE editor for a document lets VS Code GC the
// backing document, so a post-dispose write would silently do nothing — a VS
// Code lifecycle constraint, NOT a limit of the host reducer/wiring (whose
// post-dispose drain logic is pinned deterministically by the host-session-core
// unit suite). Holding the document open isolates THIS test to the drain
// mechanism, and mirrors the real case where the post-dispose drain matters:
// the file is open in another editor, so it outlives the Quoll tab. A lone-tab
// close-without-save has no bytes to preserve in the first place.
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
    const gate = deferred<boolean>();
    let calls = 0;
    harness.applyEditOverride = (edit) => {
      calls += 1;
      if (calls === 1) {
        return vscode.workspace.applyEdit(edit).then((ok) => gate.promise.then(() => ok));
      }
      return vscode.workspace.applyEdit(edit);
    };

    // Edit #1 enters the accept arm, applies for real, and holds the lock.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
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
    const drained = "drained last keystroke";
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: drained,
      baseDocVersion: seed.message.docVersion,
    });

    // Dispose BEFORE releasing edit #1 — the race: type-one-more + close in the
    // same ms. onDidDispose sets disposed + clears the lock; the stash survives.
    panel.webviewPanel.dispose();
    await tick(50);

    // Release edit #1: its settlement fires post-dispose and drains the stash
    // through the full write-gate via a real applyEdit, re-based onto "first".
    gate.resolve(true);

    const deadline = Date.now() + 3000;
    while (calls < 2 && Date.now() < deadline) {
      await tick(20);
    }
    assert.strictEqual(calls, 2, "the stashed edit must drain via a real applyEdit after dispose");
    await tick(50); // let the drain's real applyEdit land on the document

    assert.strictEqual(doc.getText(), drained, "stashed edit #2 bytes must reach the TextDocument");
    assert.ok(doc.isDirty, "the drained write must leave the document dirty (unsaved)");
  });
});
