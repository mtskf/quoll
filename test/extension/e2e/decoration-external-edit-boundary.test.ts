// External-edit byte-identity across a token boundary: a host-dispatched
// WorkspaceEdit that inserts text inside a Strong span must survive
// byte-identically in the on-disk document and not crash the decoration
// orchestrator when the syntax tree shifts under it.
//
// This e2e does NOT exercise the IME composition path — composition events
// land on the webview's contenteditable, not via WorkspaceEdit. The IME
// composition contract is verified by Task 11 manual smoke.

import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanupBetweenTests, getHarness, isDocumentEvent, VIEW_TYPE } from "./harness";

describe("C4a external-edit byte-identity across a token boundary", function () {
  this.timeout(20000);

  let tempFile: string | null = null;

  before(async () => {
    await getHarness(); // force activation before any test in this file runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
      tempFile = null;
    }
  });

  it("a host edit inside a Strong span survives byte-identically", async () => {
    // Per-test temp file so a mid-test failure does not leave any shared
    // fixture dirty for subsequent tests. Mirrors the pattern used by
    // external-edit-propagates.test.ts.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-c4a-"));
    tempFile = path.join(dir, "boundary.md");
    const initial = "**bold** rest";
    await fs.writeFile(tempFile, initial);
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    // Wait for the eager-seed Document — the webview-ready equivalent in
    // this harness. The orchestrator has mounted by the time the seed
    // Document is recorded.
    await harness.waitForEvent(isDocumentEvent, 8000);

    // Insert "XY" between `**` and `b` (host-side, NOT through the webview's
    // composition path — this is the external-edit reseed contract). The
    // resulting doc must be exactly "**XYbold** rest".
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 2), "XY");
    const applied = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(applied, true, "external applyEdit must succeed against a writable file");

    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.getText(), "**XYbold** rest");
  });
});
