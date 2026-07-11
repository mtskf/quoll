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
const customTab =
  (uri: vscode.Uri) =>
  (t: vscode.Tab): boolean =>
    t.input instanceof vscode.TabInputCustom &&
    t.input.viewType === VIEW_TYPE &&
    t.input.uri.toString() === uri.toString();
const textTab =
  (uri: vscode.Uri) =>
  (t: vscode.Tab): boolean =>
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
      if (tabs.some(textTab(uri)) && !tabs.some(customTab(uri))) {
        break;
      }
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(textTab(uri)), "text tab must be open");
    assert.ok(
      !tabs.some(customTab(uri)),
      `Quoll tab must be closed — ${JSON.stringify(tabs.map((t) => t.label))}`
    );
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
      if (tabs.some(customTab(uri)) && !tabs.some(textTab(uri))) {
        break;
      }
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(customTab(uri)), "Quoll tab must be open");
    assert.ok(
      !tabs.some(textTab(uri)),
      `text tab must be closed — ${JSON.stringify(tabs.map((t) => t.label))}`
    );
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
      if (tabs.some(textTab(uri)) && !tabs.some(customTab(uri))) {
        break;
      }
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(textTab(uri)), "text tab must be open");
    assert.ok(!tabs.some(customTab(uri)), "Quoll tab must be closed");
  });

  it("forward via quoll.reopenInTextEditor command: Quoll→text closes the Quoll tab", async () => {
    // Pins the title-bar button's command-id → handler wiring end-to-end. The
    // other forward cases drive the webview switch-to-text host path
    // (simulateInbound); this one invokes the NEW command id the file-code
    // title-bar button is wired to, so a typo between package.json's
    // contributes.commands / editor/title menu and extension.ts's
    // registerCommand would surface here (package-contributions.test.ts only
    // asserts the declarative shape, never invokes the command).
    const uri = tempMd("cmd-fwd.md");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(300);

    await vscode.commands.executeCommand("quoll.reopenInTextEditor");

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tabs = allTabs();
      if (tabs.some(textTab(uri)) && !tabs.some(customTab(uri))) {
        break;
      }
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(textTab(uri)), "text tab must be open");
    assert.ok(
      !tabs.some(customTab(uri)),
      `Quoll tab must be closed — ${JSON.stringify(tabs.map((t) => t.label))}`
    );
  });

  it("reverse (clean): text→Quoll closes the text tab", async () => {
    const uri = tempMd("clean-rev.md");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: false,
    });
    await tick(300);
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      uri.toString(),
      "precondition: the markdown text editor is active"
    );

    await vscode.commands.executeCommand("quoll.toggleEditor");

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tabs = allTabs();
      if (tabs.some(customTab(uri)) && !tabs.some(textTab(uri))) {
        break;
      }
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(customTab(uri)), "Quoll tab must be open");
    assert.ok(!tabs.some(textTab(uri)), "text tab must be closed");
  });

  it("cat button (clean): quoll.editWith on a text tab closes the text tab, no second tab", async () => {
    // Regression for the title-bar cat button (quoll.editWith) opening a SECOND
    // Quoll tab beside the source instead of swapping in place. The reverse cases
    // above drive quoll.toggleEditor; the cat button is a SEPARATE command that
    // pre-fix ran raw vscode.openWith with no source-tab close — so the text tab
    // survived (both open). Post-fix it drives the shared reopenTextEditorAsQuoll
    // helper (findSourceTab + finalizeSurfaceSwap), same as the toggle path.
    const uri = tempMd("cat-clean.md");
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: false,
    });
    await tick(300);
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      uri.toString(),
      "precondition: the markdown text editor is active"
    );

    await vscode.commands.executeCommand("quoll.editWith");

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tabs = allTabs();
      if (tabs.some(customTab(uri)) && !tabs.some(textTab(uri))) {
        break;
      }
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(customTab(uri)), "Quoll tab must be open");
    assert.ok(
      !tabs.some(textTab(uri)),
      `text tab must be closed (no second tab) — ${JSON.stringify(tabs.map((t) => t.label))}`
    );
  });

  it("cat button (dirty): quoll.editWith on a dirty text tab closes it, keeps edits", async () => {
    const uri = tempMd("cat-dirty.md");
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

    await vscode.commands.executeCommand("quoll.editWith");

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tabs = allTabs();
      if (tabs.some(customTab(uri)) && !tabs.some(textTab(uri))) {
        break;
      }
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(tabs.some(customTab(uri)), "Quoll tab must be open");
    assert.ok(
      !tabs.some(textTab(uri)),
      `text tab must be closed — ${JSON.stringify(tabs.map((t) => t.label))}`
    );
    const after = await vscode.workspace.openTextDocument(uri);
    assert.ok(after.getText().startsWith("EDIT "), "unsaved edit must be preserved");
  });

  it("multi-split: reverse toggle from the ACTIVE group consolidates it to Quoll; the other split's text tab survives", async () => {
    const activeGroupTabs = (): readonly vscode.Tab[] =>
      vscode.window.tabGroups.activeTabGroup.tabs;
    const uri = tempMd("split.md");
    const doc = await vscode.workspace.openTextDocument(uri);
    // Open the doc as text in a SECOND group (Beside), then re-focus the first
    // group and show it there too, so the same doc is a text editor in two
    // splits with the FIRST group active at toggle time.
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
      preview: false,
    });
    await tick(200);
    await vscode.commands.executeCommand("workbench.action.focusFirstEditorGroup");
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: false,
    });
    await tick(300);
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      uri.toString(),
      "precondition: active group shows the text editor"
    );
    assert.ok(
      allTabs().filter(textTab(uri)).length >= 2,
      "precondition: the doc is open as text in two splits"
    );

    await vscode.commands.executeCommand("quoll.toggleEditor");

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (
        activeGroupTabs().some(customTab(uri)) &&
        !activeGroupTabs().some(textTab(uri)) &&
        allTabs().some(textTab(uri))
      ) {
        break;
      }
      await tick(100);
    }
    assert.ok(activeGroupTabs().some(customTab(uri)), "active group shows Quoll");
    assert.ok(
      !activeGroupTabs().some(textTab(uri)),
      `active group's text tab must be closed — ${JSON.stringify(
        activeGroupTabs().map((t) => t.label)
      )}`
    );
    assert.ok(
      allTabs().some(textTab(uri)),
      "the OTHER split's text tab is preserved (the toggle acts on the active group)"
    );
  });

  it("multi-split from the SECOND group: closes the toggled group's text tab, not the first split's", async () => {
    // Regression for the reresolveTab first-match-across-all-groups bug: toggling
    // from a group that is NOT first in window.tabGroups.all must close THAT
    // group's text tab, not another split's (which left both surfaces open in the
    // toggled group). The earlier multi-split test toggles from the first group,
    // where first-match coincidentally = the right tab, so it does NOT catch this.
    const uri = tempMd("split2.md");
    const doc = await vscode.workspace.openTextDocument(uri);
    // First group's text editor, then a SECOND group (Beside) which stays active.
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false,
    });
    await tick(200);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
      preview: false,
    });
    await tick(300);
    assert.ok(
      allTabs().filter(textTab(uri)).length >= 2,
      "precondition: the doc is open as text in two groups"
    );
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      uri.toString(),
      "precondition: the SECOND group's text editor is active"
    );

    await vscode.commands.executeCommand("quoll.toggleEditor");

    // The Quoll tab's group must NOT also still hold a text tab for the doc
    // (that would be both-open in the toggled group), and the first split's text
    // tab must survive.
    const quollGroupTabs = (): readonly vscode.Tab[] => {
      const g = vscode.window.tabGroups.all.find((grp) => grp.tabs.some(customTab(uri)));
      return g ? g.tabs : [];
    };
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (
        allTabs().some(customTab(uri)) &&
        !quollGroupTabs().some(textTab(uri)) &&
        allTabs().some(textTab(uri))
      ) {
        break;
      }
      await tick(100);
    }
    assert.ok(allTabs().some(customTab(uri)), "Quoll tab must be open");
    assert.ok(
      !quollGroupTabs().some(textTab(uri)),
      `Quoll's group must not also hold a text tab (would be both-open) — ${JSON.stringify(
        quollGroupTabs().map((t) => t.label)
      )}`
    );
    assert.ok(
      allTabs().some(textTab(uri)),
      "the first split's text tab must survive (only the toggled group is consolidated)"
    );
  });
});
