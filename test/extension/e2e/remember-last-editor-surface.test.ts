// Regression: within one session, a `.md` reopens in the surface it was last
// shown in (session-only, in-memory). Quoll's custom-editor priority is
// "option", so a FRESH open lands in the built-in text editor
// (vscode.openWith(uri, "default") is the default-surface proxy here). Restore
// is asymmetric (upgrade-to-Quoll only): a Quoll tab opening is always
// intentional and adopted; only a default text open is upgraded back to a
// remembered Quoll surface. Native Open-With-Quoll and deliberate toggles must
// NOT be bounced. Temp files so nothing is mutated and each case has a fresh
// uri key (surface memory is session-lived, never reset between e2e tests).

import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isDocumentEvent, tick, VIEW_TYPE } from "./harness";

function tempMd(name: string): vscode.Uri {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quoll-surface-"));
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

async function openInQuoll(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  const harness = await getHarness();
  await harness.waitForEvent(isDocumentEvent, 8000);
  await tick(300);
}
async function openInText(uri: vscode.Uri): Promise<void> {
  await vscode.commands.executeCommand("vscode.openWith", uri, "default");
  await tick(300);
}
async function closeDocTabs(uri: vscode.Uri): Promise<void> {
  const tabs = allTabs().filter((t) => customTab(uri)(t) || textTab(uri)(t));
  for (const t of tabs) {
    await vscode.window.tabGroups.close(t, true);
  }
  await tick(300);
}
async function waitFor(pred: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) {
      return;
    }
    await tick(100);
  }
}

describe("remember last editor surface (session-only)", function () {
  this.timeout(30000);

  before(async () => {
    await getHarness();
  });
  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("Quoll remembered: reopening a file lands it back in Quoll (not text)", async () => {
    const uri = tempMd("remember-quoll.md");
    // Show it in Quoll first — the watcher records "quoll".
    await openInQuoll(uri);
    assert.ok(allTabs().some(customTab(uri)), "precondition: open in Quoll");
    // Close, then FRESH-open (lands in text by "option" priority).
    await closeDocTabs(uri);
    await openInText(uri);
    // The watcher must reopen it in Quoll and close the text tab.
    await waitFor(() => allTabs().some(customTab(uri)) && !allTabs().some(textTab(uri)));
    const tabs = allTabs();
    assert.ok(tabs.some(customTab(uri)), "reopened in Quoll");
    assert.ok(
      !tabs.some(textTab(uri)),
      `text tab consolidated — ${JSON.stringify(tabs.map((t) => t.label))}`
    );
  });

  it("text remembered: reopening a file stays in text (no bounce to Quoll)", async () => {
    const uri = tempMd("remember-text.md");
    // Show in Quoll, then toggle to text — the toggle records "text".
    await openInQuoll(uri);
    const panel = (await getHarness()).activePanel;
    assert.ok(panel, "no active panel");
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });
    await waitFor(() => allTabs().some(textTab(uri)) && !allTabs().some(customTab(uri)));
    // Close, then FRESH-open (text).
    await closeDocTabs(uri);
    await openInText(uri);
    await tick(600); // give any (erroneous) restore time to fire
    const tabs = allTabs();
    assert.ok(tabs.some(textTab(uri)), "stays in text");
    assert.ok(!tabs.some(customTab(uri)), "not bounced to Quoll");
  });

  it("native Open With → Quoll is never bounced, even when text is remembered", async () => {
    const uri = tempMd("open-with.md");
    // Remember text (fresh text open records "text") — the DEFAULT memory state.
    await openInText(uri);
    await tick(300);
    // Now open Quoll (native Open-With analogue). Under the asymmetric rule a
    // Quoll open is always intentional (priority "option" never defaults to
    // Quoll), so it must be adopted, NOT bounced back to text.
    await openInQuoll(uri);
    await tick(600); // give any (erroneous) bounce time to fire
    assert.ok(allTabs().some(customTab(uri)), "Quoll surface adopted (not bounced away)");
  });

  it("no memory: a first fresh open is left in text (default), not disturbed", async () => {
    const uri = tempMd("first-open.md");
    await openInText(uri);
    await tick(600);
    const tabs = allTabs();
    assert.ok(tabs.some(textTab(uri)), "left in text");
    assert.ok(!tabs.some(customTab(uri)), "no spurious Quoll reopen");
  });
});
