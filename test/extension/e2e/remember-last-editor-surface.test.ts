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
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  makeTempDirSync,
  tick,
  VIEW_TYPE,
} from "./harness";

function tempMd(name: string): vscode.Uri {
  const dir = makeTempDirSync("surface");
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
const isEditRejectedEvent = (e: { message: { type: string } }): boolean =>
  e.message.type === "edit-rejected";
type QuollPanel = NonNullable<Awaited<ReturnType<typeof getHarness>>["activePanel"]>;

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
// ONE array close: every handle comes from a single tab-model snapshot before
// any close runs. Closing a snapshot tab-by-tab can hand a stale `Tab` to the
// second close once the first has fired a tab-model event (the hazard
// surface-swap.ts reresolveTab documents) — reachable as soon as both the
// Quoll and the text tab are open at close time.
async function closeDocTabs(uri: vscode.Uri): Promise<void> {
  const matches = (t: vscode.Tab): boolean => customTab(uri)(t) || textTab(uri)(t);
  const tabs = allTabs().filter(matches);
  if (tabs.length > 0) {
    assert.ok(await vscode.window.tabGroups.close(tabs, true));
  }
  await tick(300);
  assert.ok(!allTabs().some(matches), "all document tabs closed before fresh reopen");
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

  // A forward swap refused by a write-gate rejection that lands DURING the async
  // text open must leave Quoll remembered. The watcher records "text" the moment
  // the text tab opens beside the still-open Quoll tab (sibling-adopt), so the
  // swap site must correct it to "quoll" once it refuses (ARCH-06a-3).
  //
  // Arm-reached: BOTH tabs open proves the target text tab was created, which
  // excludes a pre-open (receipt / drain / fast-path) refusal — that would pass
  // vacuously, since the initial Quoll open already left memory "quoll". It
  // does not distinguish the post-open rejection check from the finalize abort
  // backstop (both end "quoll"); timing decides which one runs.
  async function rejectDuringOpen(
    uri: vscode.Uri,
    startSwap: (panel: QuollPanel) => Thenable<unknown> | undefined
  ): Promise<void> {
    const harness = await getHarness();
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel");
    harness.clearEvents();
    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;
    const swap = startSwap(panel);
    // Same synchronous block as the swap start: the invalid edit is processed
    // before the text open resolves.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      editId: 21,
      content: `${seededContent}\n[bad](javascript:alert(1))\n`,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);
    await swap;
    await tick(800);
    const tabs = allTabs();
    const labels = JSON.stringify(tabs.map((t) => t.label));
    assert.ok(tabs.some(customTab(uri)), `arm reached: Quoll tab retained — ${labels}`);
    assert.ok(tabs.some(textTab(uri)), `arm reached: target text tab was opened — ${labels}`);
    // Safe to close with the rejection still pending: the E2E harness
    // suppresses the rejected-draft rescue (suppressRescuedDrafts), so no
    // rescue tab opens and the close is a plain discard.
    await closeDocTabs(uri);
    // FRESH text open: a remembered "quoll" upgrades it back to Quoll.
    await openInText(uri);
    await waitFor(() => allTabs().some(customTab(uri)) && !allTabs().some(textTab(uri)));
    const reopened = allTabs();
    assert.ok(reopened.some(customTab(uri)), "Quoll still remembered: reopened in Quoll");
    assert.ok(
      !reopened.some(textTab(uri)),
      `text tab consolidated — ${JSON.stringify(reopened.map((t) => t.label))}`
    );
  }

  it("rejected switch-to-text (webview arm): Quoll stays remembered", async () => {
    const uri = tempMd("reject-webview-swap.md");
    await rejectDuringOpen(uri, (panel) => {
      panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });
      return undefined;
    });
  });

  it("rejected reopenInTextEditor (command arm): Quoll stays remembered", async () => {
    const uri = tempMd("reject-command-swap.md");
    // NOT awaited before the invalid edit: the command's fast-path check runs
    // synchronously, then it suspends on the text open. Timing is not enforced —
    // this pins the combined rejection/abort outcome, not exclusive execution of
    // the post-open rejection arm (toggle-editor.test.ts pins that arm's write).
    await rejectDuringOpen(uri, () => vscode.commands.executeCommand("quoll.reopenInTextEditor"));
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
