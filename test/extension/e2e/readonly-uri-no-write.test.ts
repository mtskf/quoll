import * as assert from "node:assert";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, VIEW_TYPE } from "./harness";

describe("readonly-uri-no-write", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness(); // force activation before any test in this file runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("does not attempt applyEdit when the document URI is untitled (non-writable)", async () => {
    const harness = await getHarness();

    const untitledUri = vscode.Uri.parse("untitled:untitled-quoll-test.md");
    await vscode.workspace.openTextDocument(untitledUri);
    await vscode.commands.executeCommand("vscode.openWith", untitledUri, VIEW_TYPE);

    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    assert.strictEqual(seed.message.canWrite, false, "untitled URI must emit canWrite=false");

    let applyEditCalls = 0;
    harness.applyEditOverride = async () => {
      applyEditCalls += 1;
      return true;
    };

    const panel = harness.activePanel;
    assert.ok(panel);

    // Drain the seed BEFORE driving the inbound Edit so the next
    // Document we await is unambiguously the readonly-verdict resync.
    // The previous `e.timestamp > seedTimestamp` predicate raced
    // Date.now()'s 1ms resolution on fast CI — strictly-greater could
    // be permanently false when seed and resync land in the same ms.
    harness.clearEvents();
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "would-be-saved content",
      baseDocVersion: seed.message.docVersion,
    });

    await harness.waitForEvent(isDocumentEvent, 3000);

    assert.strictEqual(
      applyEditCalls,
      0,
      "applyEdit must NOT be called for untitled URIs (canWrite=false)"
    );
  });
});
