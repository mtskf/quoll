// Platform contract pinned by QuollEditorPanel's revealForMention (the ⌘⌥K
// Claude Code handoff, tier 0). The feature delegates to Claude Code's
// zero-arg `claude-code.insertAtMentioned`, which reads
// window.activeTextEditor — so the reveal's showTextDocument options rest on
// three empirical VS Code behaviours (originally established by a throwaway
// probe in a real host) that this spec ASSERTS so an upstream change breaks
// loudly here instead of as a silently no-oping handoff:
//
//   (i)  With a quoll.editMarkdown custom tab active, showTextDocument with
//        ViewColumn.Active + preserveFocus:false sets window.activeTextEditor
//        to the document by the time the promise resolves. (preserveFocus:true
//        NEVER sets it — the original live bug — so the option is load-bearing.)
//   (ii) The reveal opens a SECOND text tab in the same group alongside the
//        custom tab; it does not replace the custom tab.
//   (iii) Closing that text tab via tabGroups.close leaves the custom tab
//        present AND active again, with the TextDocument still open.

import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
  VIEW_TYPE,
} from "./harness";

describe("reveal-for-mention platform contract", function () {
  this.timeout(30000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("Active + preserveFocus:false sets activeTextEditor, coexists with the custom tab, and restores it on close", async () => {
    // Open the fixture with the Quoll custom editor and let the seed settle.
    const uri = await openFixtureWithQuoll("sample.md");
    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(300); // quiesce the seed/ready handshake

    const isThisDocCustomTab = (tab: vscode.Tab): boolean =>
      tab.input instanceof vscode.TabInputCustom &&
      tab.input.viewType === VIEW_TYPE &&
      tab.input.uri.toString() === uri.toString();
    const isThisDocTextTab = (tab: vscode.Tab): boolean =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();

    // Precondition: the Quoll custom tab is the active tab (the state the
    // handoff reveal always starts from) and no text editor is active.
    const activeBefore = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(
      activeBefore !== undefined && isThisDocCustomTab(activeBefore),
      "precondition: the Quoll custom tab must be the active tab"
    );

    // (i) The reveal, exactly as revealForMention issues it: same group
    // (Active), focus taken (preserveFocus:false), lightweight preview tab.
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: true,
      selection: new vscode.Selection(0, 0, 0, 0),
    });
    assert.strictEqual(
      vscode.window.activeTextEditor?.document.uri.toString(),
      uri.toString(),
      "activeTextEditor must point at the revealed document by showTextDocument resolution"
    );

    // (ii) The group holds BOTH tabs — the custom tab was not replaced.
    const groupTabs = vscode.window.tabGroups.activeTabGroup.tabs;
    assert.ok(
      groupTabs.some(isThisDocCustomTab),
      "the custom tab must survive the same-group text reveal"
    );
    assert.ok(groupTabs.some(isThisDocTextTab), "the reveal must open a text tab for the doc");

    // (iii) Closing the text tab restores the custom tab as the active tab
    // and leaves the document open.
    const textTabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isThisDocTextTab);
    assert.ok(textTabs.length > 0, "expected at least one text tab to close");
    await vscode.window.tabGroups.close(textTabs, true);
    await tick(300); // let the tab model settle on the re-activation

    const customTab = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => isThisDocCustomTab(t));
    assert.ok(customTab !== undefined, "the custom tab must still exist after the close");
    assert.strictEqual(customTab.isActive, true, "the custom tab must be active again");
    assert.strictEqual(doc.isClosed, false, "the TextDocument must survive the tab close");
  });
});
