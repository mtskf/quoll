// Regression spec for the ⌘⌥K handoff cleanup CONTRACT (QuollEditorPanel's
// revealForMention): after the reveal's cleanup, the Quoll custom tab for the
// document is the ACTIVE tab of its group again.
//
// The bug class this pins (H2 — user-reproduced in a real host with Claude
// Code installed): the user's group already holds a BACKGROUND text tab for
// the doc while the Quoll custom tab is active. The reveal's showTextDocument
// (ViewColumn.Active — the background tab is not in visibleTextEditors, so no
// visibleColumn is found) REUSES that pre-existing text tab and activates it.
// A snapshot-only cleanup ("close text tabs only in groups that did not hold
// one pre-reveal") then skips the group entirely — nothing is closed, the
// reused text tab stays active, and the pane never returns to Quoll.
//
// This spec drives the REAL production path (simulateInbound →
// handleContextHandoff → revealForMention + cleanup). The test host has no
// Claude Code, so `claude-code.insertAtMentioned` rejects into the clipboard
// fallback tier — but the reveal and the cleanup (the code under test) run
// exactly as in production; the cleanup always runs in the delegation's
// `finally`.
//
// Also pinned: the reuse-case cleanup must NOT close the user's own
// pre-existing text tab — it re-activates the custom tab IN FRONT of it.

import * as assert from "node:assert";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
  VIEW_TYPE,
} from "./harness";

describe("context-handoff reveal cleanup (pre-existing text tab reuse)", function () {
  this.timeout(30000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("re-activates the Quoll custom tab after a handoff that reused a background text tab in the same group", async () => {
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

    // Diagnostic inventory for assertion messages — pins WHICH tab-model
    // state a failure happened in without re-running under a debugger.
    const inventory = (): string =>
      JSON.stringify(
        vscode.window.tabGroups.all.map((g) => ({
          viewColumn: g.viewColumn,
          tabs: g.tabs.map((t) => ({
            label: t.label,
            isActive: t.isActive,
            kind:
              t.input instanceof vscode.TabInputCustom
                ? `custom:${t.input.viewType}`
                : t.input instanceof vscode.TabInputText
                  ? "text"
                  : "other",
          })),
        }))
      );

    // Arrange the H2 state: a BACKGROUND text tab of THIS doc coexisting in
    // the SAME group as the ACTIVE custom tab. showTextDocument opens the
    // text editor as a second tab alongside the custom tab and activates it
    // (platform facts pinned by reveal-for-mention-platform.test.ts);
    // previousEditorInGroup then re-activates the custom tab (tab order is
    // [custom, text] — the text tab was appended after it), leaving the text
    // tab in the background. preview:false so the tab behaves like the
    // user's own pinned tab, not a transient preview.
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: false,
    });
    await vscode.commands.executeCommand("workbench.action.previousEditorInGroup");
    await tick(300); // let the tab model settle on the activation flip

    // Precondition — fail loudly (with the inventory) if the arrangement
    // did not produce the H2 state.
    const groupTabs = vscode.window.tabGroups.activeTabGroup.tabs;
    const customBefore = groupTabs.find(isThisDocCustomTab);
    const textBefore = groupTabs.find(isThisDocTextTab);
    assert.ok(
      customBefore !== undefined && textBefore !== undefined,
      `precondition: custom and text tabs must coexist in the active group — ${inventory()}`
    );
    assert.strictEqual(
      customBefore.isActive,
      true,
      `precondition: the custom tab must be active — ${inventory()}`
    );
    assert.strictEqual(
      textBefore.isActive,
      false,
      `precondition: the text tab must be a background tab — ${inventory()}`
    );

    // Act — drive the real handoff through the production inbound path.
    // Settlement signal: the test host has no Claude Code, so the delegation
    // rejects and the FALLBACK tier writes the reference to the clipboard —
    // and that write happens strictly AFTER the cleanup (which runs in the
    // delegation's `finally`). Seed a sentinel first; when the clipboard
    // changes, the cleanup (the code under test) has fully completed.
    const sentinel = "quoll-e2e-clipboard-sentinel";
    await vscode.env.clipboard.writeText(sentinel);
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "context-handoff",
      hasSelection: false,
      startLine: 1,
      endLine: 1,
    });

    const settleDeadline = Date.now() + 8000;
    while (Date.now() < settleDeadline) {
      if ((await vscode.env.clipboard.readText()) !== sentinel) {
        break;
      }
      await tick(50);
    }
    assert.notStrictEqual(
      await vscode.env.clipboard.readText(),
      sentinel,
      "the handoff never settled (no fallback clipboard write observed)"
    );

    // The cleanup contract may need one more tab-model beat after openWith
    // resolves — give it a short bounded poll before asserting.
    const findCustom = (): vscode.Tab | undefined =>
      vscode.window.tabGroups.all.flatMap((g) => g.tabs).find(isThisDocCustomTab);
    const contractDeadline = Date.now() + 2000;
    while (Date.now() < contractDeadline) {
      if (findCustom()?.isActive) {
        break;
      }
      await tick(100);
    }

    const customAfter = findCustom();
    assert.ok(
      customAfter !== undefined,
      `the Quoll custom tab must still exist after the handoff cleanup — ${inventory()}`
    );
    assert.strictEqual(
      customAfter.isActive,
      true,
      `cleanup contract: the Quoll custom tab must be the active tab of its group again — ${inventory()}`
    );
    // The user's own pre-existing text tab must survive the cleanup (the
    // reuse case re-activates the custom tab in front of it, never closes it).
    const textAfter = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => isThisDocTextTab(t));
    assert.ok(
      textAfter !== undefined,
      `the user's pre-existing text tab must NOT be closed by the cleanup — ${inventory()}`
    );
  });
});
