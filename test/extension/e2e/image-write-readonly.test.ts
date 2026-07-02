import * as assert from "node:assert";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, VIEW_TYPE } from "./harness";

describe("image-write-readonly", function () {
  this.timeout(15000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("rejects an image-write on an untitled (non-writable) document without writing a file", async () => {
    const harness = await getHarness();

    const untitledUri = vscode.Uri.parse("untitled:untitled-quoll-image-test.md");
    await vscode.workspace.openTextDocument(untitledUri);
    await vscode.commands.executeCommand("vscode.openWith", untitledUri, VIEW_TYPE);

    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    assert.strictEqual(seed.message.canWrite, false, "untitled URI must emit canWrite=false");

    let writeCalls = 0;
    harness.writeImageFileOverride = async () => {
      writeCalls += 1;
    };

    const panel = harness.activePanel;
    assert.ok(panel);

    harness.clearEvents();
    const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
      "base64"
    );
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "image-write",
      requestId: "t1",
      data: pngBase64,
    });

    const result = await harness.waitForEvent((e) => e.message.type === "image-write-result", 3000);
    assert.strictEqual(
      (result.message as unknown as { ok: boolean }).ok,
      false,
      "readonly doc must reject"
    );
    assert.strictEqual(writeCalls, 0, "writeFile must NOT be called for a non-writable URI");
  });
});
