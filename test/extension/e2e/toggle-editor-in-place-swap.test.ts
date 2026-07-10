// Regression: ⌘⌥E swaps the editing surface IN PLACE (the source tab is closed;
// never both open) and preserves unsaved edits via save-then-close. Root cause:
// vscode.openWith opens the target as a SECOND tab beside the source (E2E-probed
// 2026-07-10); closing a dirty source tab would revert the shared working copy,
// so the swap saves first. Forward drives the production switch-to-text host
// path (simulateInbound); reverse drives the real quoll.toggleEditor command.
// Temp files so save() never mutates a committed fixture.

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, tick, VIEW_TYPE } from "./harness";

function tempMd(name: string): vscode.Uri {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quoll-swap-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, "# Title\n\nbody\n", "utf8");
  return vscode.Uri.file(p);
}
const customTab = (uri: vscode.Uri) => (t: vscode.Tab): boolean =>
  t.input instanceof vscode.TabInputCustom &&
  t.input.viewType === VIEW_TYPE &&
  t.input.uri.toString() === uri.toString();
const textTab = (uri: vscode.Uri) => (t: vscode.Tab): boolean =>
  t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString();
const allTabs = (): vscode.Tab[] => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
async function dirty(uri: vscode.Uri): Promise<void> {
  const e = new vscode.WorkspaceEdit();
  e.insert(uri, new vscode.Position(0, 0), "EDIT ");
  await vscode.workspace.applyEdit(e);
}

describe("⌘⌥E in-place editor-surface swap", function () {
  this.timeout(30000);

  before(async () => {
    await getHarness();
  });
  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("forward (dirty): Quoll→text closes the Quoll tab, keeps edits", async () => {
    const uri = tempMd("fwd.md");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(300);
    await dirty(uri);
    await tick(200);

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel");
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tabs = allTabs();
      if (tabs.some(textTab(uri)) && !tabs.some(customTab(uri))) break;
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(textTab(uri)), "text tab must be open");
    assert.ok(!tabs.some(customTab(uri)), `Quoll tab must be closed — ${JSON.stringify(tabs.map((t) => t.label))}`);
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.ok(doc.getText().startsWith("EDIT "), "unsaved edit must be preserved");
    assert.strictEqual(doc.isDirty, false, "save-then-close leaves the doc clean");
  });

  it("reverse (dirty): text→Quoll closes the text tab, keeps edits", async () => {
    const uri = tempMd("rev.md");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: false,
    });
    await tick(300);
    await dirty(uri);
    await tick(200);
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      uri.toString(),
      "precondition: the markdown text editor is active"
    );

    await vscode.commands.executeCommand("quoll.toggleEditor");

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tabs = allTabs();
      if (tabs.some(customTab(uri)) && !tabs.some(textTab(uri))) break;
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(customTab(uri)), "Quoll tab must be open");
    assert.ok(!tabs.some(textTab(uri)), `text tab must be closed — ${JSON.stringify(tabs.map((t) => t.label))}`);
    const after = await vscode.workspace.openTextDocument(uri);
    assert.ok(after.getText().startsWith("EDIT "), "unsaved edit must be preserved");
  });

  it("forward (clean): Quoll→text closes the Quoll tab, no disk churn needed", async () => {
    const uri = tempMd("clean.md");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(300);

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel");
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tabs = allTabs();
      if (tabs.some(textTab(uri)) && !tabs.some(customTab(uri))) break;
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(textTab(uri)), "text tab must be open");
    assert.ok(!tabs.some(customTab(uri)), "Quoll tab must be closed");
  });
});
