import * as assert from "node:assert";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  fixtureUri,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
  VIEW_TYPE,
} from "./harness";

// Data-loss repro: closing a Quoll custom editor whose shared TextDocument is
// dirty (and still open in a built-in text editor) must NOT discard the dirty
// bytes. VS Code reverts the shared working copy on the "Don't Save" close path
// (revertAndCloseActiveEditor is that path minus the modal dialog); the panel's
// revert-rescue must restore them because another editor still holds the doc.
describe("preserve-unsaved-on-close", function () {
  this.timeout(30000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    await cleanupBetweenTests(await getHarness());
  });

  it("both editors open: closing Quoll (Don't Save) does not lose the text editor's unsaved edits", async () => {
    const harness = await getHarness();
    const uri = fixtureUri("sample.md");

    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), "DIRTY_PREFIX "));
    assert.ok(doc.isDirty, "precondition: dirty");
    const dirtyText = doc.getText();

    // Open Quoll BESIDE — both tabs open on the same shared TextDocument.
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, vscode.ViewColumn.Two);
    await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(400);

    // "Don't Save" close of the focused Quoll tab (revert-then-close, no dialog).
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    // The rescue applyEdit is async off onDidDispose — poll for it to land.
    const deadline = Date.now() + 3000;
    let reDoc = await vscode.workspace.openTextDocument(uri);
    while (reDoc.getText() !== dirtyText && Date.now() < deadline) {
      await tick(50);
      reDoc = await vscode.workspace.openTextDocument(uri);
    }

    assert.strictEqual(reDoc.getText(), dirtyText, "dirty edits must survive closing Quoll");
    assert.ok(reDoc.isDirty, "document must still be dirty (unsaved) after Quoll closes");
  });

  it("sole editor: closing Quoll (Don't Save) honours the discard (no rescue)", async () => {
    const harness = await getHarness();
    const uri = fixtureUri("sample.md");
    const original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");

    // Open ONLY in Quoll (no text editor holds the doc), then dirty it via a
    // webview edit through the host write path — so Quoll is the sole editor.
    await openFixtureWithQuoll("sample.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const panel = harness.activePanel;
    assert.ok(panel, "no active Quoll panel");

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `SOLE_DIRTY ${original}`,
      baseDocVersion: seed.message.docVersion,
    });
    const doc = panel.document;
    const dirtyDeadline = Date.now() + 3000;
    while (!doc.isDirty && Date.now() < dirtyDeadline) {
      await tick(30);
    }
    assert.ok(doc.isDirty, "precondition: Quoll-only doc is dirty");

    // "Don't Save" close of the sole Quoll editor.
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await tick(800);

    // No surviving editor -> the discard is honoured: disk content, not dirty.
    const reDoc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(
      reDoc.getText(),
      original,
      "sole-editor discard must be honoured (disk content)"
    );
    assert.ok(!reDoc.isDirty, "sole-editor discard must leave the document clean");
  });

  it("control: closing one of two TEXT editors of a dirty doc does not revert", async () => {
    const uri = fixtureUri("sample.md");
    const uriStr = uri.toString();

    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), "DIRTY_PREFIX "));
    const dirtyText = doc.getText();
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two });
    await tick(300);

    const secondTab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => {
        const inp = t.input as { uri?: vscode.Uri } | undefined;
        return inp?.uri?.toString() === uriStr && t.group.viewColumn === vscode.ViewColumn.Two;
      });
    if (secondTab) {
      await vscode.window.tabGroups.close(secondTab);
    }
    await tick(400);
    assert.strictEqual(
      doc.getText(),
      dirtyText,
      "control: closing one text editor must not revert"
    );
    assert.ok(doc.isDirty, "control: doc still dirty");
  });
});
