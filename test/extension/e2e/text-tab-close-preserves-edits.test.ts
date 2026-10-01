import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  cleanupBetweenTests,
  fixtureUri,
  getHarness,
  isDocumentEvent,
  tick,
  VIEW_TYPE,
} from "./harness";

// Reverse-direction data-loss repro (symmetric to preserve-unsaved-on-close):
// a document dirty in a built-in text editor AND open in a live Quoll editor.
// Closing the TEXT tab with "Don't Save" reverts the shared working copy (VS
// Code thinks the text editor is the last dirty holder — FileEditorInput never
// matches Quoll's CustomEditorInput). Quoll stays ALIVE and would reseed to
// disk, losing the dirty bytes. The alive-panel revert-rescue must restore them,
// while a user's explicit "Revert File" (no paired close) must still reseed.
describe("text-tab-close-preserves-edits", function () {
  this.timeout(30000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    await cleanupBetweenTests(await getHarness());
  });

  it("closing the TEXT tab (Don't Save) does not lose the dirty edits while Quoll stays open", async () => {
    const harness = await getHarness();
    const uri = fixtureUri("sample.md");

    // Dirty the doc in a built-in text editor (viewColumn One).
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), "DIRTY_PREFIX "));
    assert.ok(doc.isDirty, "precondition: dirty");
    const dirtyText = doc.getText();

    // Open Quoll BESIDE (viewColumn Two) — both editors hold the same doc.
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, vscode.ViewColumn.Two);
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    assert.strictEqual(
      seed.message.content,
      dirtyText,
      "precondition: Quoll seeded the dirty body"
    );
    await tick(400);

    // Clear recorded events so the webview assertion below sees only post-close
    // Documents. Focus the TEXT tab, then "Don't Save" close it
    // (revert-then-close, no dialog).
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await tick(200);
    harness.clearEvents();
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");

    // The rescue applyEdit is async off the tab-close / change event — poll the
    // shared TextDocument for the restored (dirty) bytes (the real data-integrity
    // contract).
    const deadline = Date.now() + 3000;
    let reDoc = await vscode.workspace.openTextDocument(uri);
    while (reDoc.getText() !== dirtyText && Date.now() < deadline) {
      await tick(50);
      reDoc = await vscode.workspace.openTextDocument(uri);
    }

    assert.strictEqual(
      reDoc.getText(),
      dirtyText,
      "dirty edits must survive closing the text tab while Quoll stays open"
    );
    assert.ok(reDoc.isDirty, "document must still be dirty (unsaved) after the text tab closes");

    // The live Quoll webview must END on the DIRTY content: the latest
    // post-close Document, or — if none was posted — the seed above. A transient
    // disk post may be interleaved (a viewStateVisible resync from the tab
    // switch — cosmetic, documented); it hands the webview the disk text, so the
    // restore's change event reposts the dirty body. With no such post the
    // restore brings back exactly the text the webview was last handed, and the
    // edit lineage keeps it silent (the webview still holds the dirty seed).
    // Poll to a deadline rather than snapshotting once (which would race the
    // async repost).
    const postDeadline = Date.now() + 3000;
    const latestDocument = () => harness.events.filter(isDocumentEvent).at(-1) ?? seed;
    while (latestDocument().message.content !== dirtyText && Date.now() < postDeadline) {
      await tick(50);
    }
    assert.strictEqual(
      latestDocument().message.content,
      dirtyText,
      "the webview must end on the restored dirty content (no disk end-state)"
    );
  });

  it("control: manual Revert File while Quoll is open reseeds to disk (external wins, no false restore)", async () => {
    const harness = await getHarness();
    const uri = fixtureUri("sample.md");
    const original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");

    // Dirty in a text editor, open Quoll beside — NO tab is closed in this test.
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await editor.edit((eb) => eb.insert(new vscode.Position(0, 0), "TEMP_DIRTY "));
    assert.ok(doc.isDirty, "precondition: dirty");

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE, vscode.ViewColumn.Two);
    await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(400);

    // Explicit user revert (no tab close). External wins: the doc goes to disk
    // content and must NOT be restored by the rescue.
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One });
    await tick(100);
    await vscode.commands.executeCommand("workbench.action.files.revert");
    await tick(800);

    const reDoc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(
      reDoc.getText(),
      original,
      "manual Revert File must reseed to disk (no false restore)"
    );
    assert.ok(!reDoc.isDirty, "manual revert must leave the document clean");
  });
});
