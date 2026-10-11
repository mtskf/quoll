import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  discardUntitledTabs,
  getHarness,
  isDocumentEvent,
  openTempQuoll,
  pollUntil,
  tick,
  untitledTextTabs,
  VIEW_TYPE,
} from "./harness";
import type { PanelControlsShape, TestHarnessShape } from "./types";

// A draft the write-gate refused never reaches the TextDocument, so closing the
// Quoll tab raises no save prompt and the bytes used to vanish with the webview.
// The panel now reopens them as an untitled Markdown document on dispose.
//
// This is the ONLY suite that runs the real rescue: `getHarness()` installs a
// no-op `openRescuedDraftOverride` for everyone else (see `suppressRescuedDrafts`
// in ./harness), so each case below sets the override AFTER its last
// `getHarness()` call — setting it earlier would be silently overwritten and the
// positive case would fail looking exactly like "wiring missing".

const ORIGINAL = "# Title\n\nbody\n";

const isEditRejectedEvent = (e: { message: { type: string } }) =>
  e.message.type === "edit-rejected";

const allTabs = (): vscode.Tab[] => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
const quollTab = (uri: vscode.Uri): vscode.Tab | undefined =>
  allTabs().find(
    (t) =>
      t.input instanceof vscode.TabInputCustom &&
      t.input.viewType === VIEW_TYPE &&
      t.input.uri.toString() === uri.toString()
  );

async function openQuoll(slug: string): Promise<{
  harness: TestHarnessShape;
  uri: vscode.Uri;
  file: string;
  panel: PanelControlsShape;
}> {
  const harness = await getHarness();
  const opened = await openTempQuoll(harness, ORIGINAL, slug, null);
  return { harness, ...opened };
}

// Post an Edit the REAL write-gate refuses (unsafe URL) and wait for the
// rejection. Returns the exact bytes sent — the draft the rescue must reopen.
async function rejectDraft(harness: TestHarnessShape, panel: PanelControlsShape): Promise<string> {
  const seed = await harness.waitForEvent(isDocumentEvent, 8000);
  harness.clearEvents();
  const draft = `# Title\n\n[bad](javascript:alert(1))\n\nRESCUE-ME-${Math.random().toString(36).slice(2)}\n`;
  panel.simulateInbound({
    protocol: PROTOCOL_VERSION,
    type: "edit",
    editId: 1,
    content: draft,
    baseDocVersion: seed.message.docVersion,
  });
  await harness.waitForEvent(isEditRejectedEvent, 5000);
  return draft;
}

async function closeQuollTab(uri: vscode.Uri): Promise<void> {
  const tab = quollTab(uri);
  assert.ok(tab, "precondition: the Quoll tab is open");
  await vscode.window.tabGroups.close(tab);
}

describe("rejected-draft-rescue-on-close", function () {
  this.timeout(30000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    await cleanupBetweenTests(await getHarness());
  });

  it("closing a Quoll tab with a rejected draft pending reopens the draft as an untitled Markdown document", async () => {
    assert.strictEqual(untitledTextTabs().length, 0, "precondition: no untitled tab open");
    // Set immediately after the close is requested: only then has a real rescue
    // been started that this case must collect, pass or fail.
    let closedWithRealRescue = false;
    try {
      const { harness, uri, file, panel } = await openQuoll("rescue-real");
      const draft = await rejectDraft(harness, panel);
      // Real path — after the last getHarness() call (see file header).
      harness.openRescuedDraftOverride = null;

      const closing = closeQuollTab(uri);
      closedWithRealRescue = true;
      await closing;

      const rescuedDoc = (): vscode.TextDocument | undefined => {
        // The TAB must exist, not just the document: an untitled document
        // nobody shows would leave the user with nothing to look at.
        const uris = untitledTextTabs().map((t) => (t.input as vscode.TabInputText).uri.toString());
        return vscode.workspace.textDocuments.find(
          (d) => uris.includes(d.uri.toString()) && d.getText() === draft
        );
      };
      await pollUntil(
        () => rescuedDoc() !== undefined,
        "an untitled tab holding the rejected draft",
        5000
      );
      const doc = rescuedDoc();
      assert.ok(doc);
      assert.strictEqual(doc.languageId, "markdown", "rescued draft must open as Markdown");
      assert.strictEqual(doc.getText(), draft, "rescued draft must be byte-identical");
      assert.strictEqual(
        await fs.readFile(file, "utf8"),
        ORIGINAL,
        "the file on disk must still hold the original bytes"
      );
    } finally {
      if (closedWithRealRescue) {
        // A slow open/show may have timed out the assertion above; give the
        // started rescue a bounded chance to land so it is discarded here and
        // not in the middle of the next test.
        await pollUntil(() => untitledTextTabs().length > 0, "rescued untitled tab", 3000).catch(
          () => undefined
        );
      }
      await discardUntitledTabs();
    }
  });

  it("closing a Quoll tab with no rejection pending opens nothing", async () => {
    assert.strictEqual(untitledTextTabs().length, 0, "precondition: no untitled tab open");
    try {
      const { harness, uri } = await openQuoll("rescue-control");
      await harness.waitForEvent(isDocumentEvent, 8000);
      // Real path, so "no untitled tab" is the rescue declining to run — not
      // the suppression swallowing it.
      harness.openRescuedDraftOverride = null;

      await closeQuollTab(uri);
      await tick(500);
      assert.strictEqual(untitledTextTabs().length, 0, "no untitled tab may open");
    } finally {
      await discardUntitledTabs();
    }
  });

  it("routes the rescue's document open through openRescuedDraftOverride when one is installed", async () => {
    assert.strictEqual(untitledTextTabs().length, 0, "precondition: no untitled tab open");
    // Pins the routing every other suite depends on to stay free of rescued
    // untitled documents.
    const { harness, uri, panel } = await openQuoll("rescue-override");
    const draft = await rejectDraft(harness, panel);
    const seen: string[] = [];
    harness.openRescuedDraftOverride = (content) => {
      seen.push(content);
      return Promise.resolve();
    };

    await closeQuollTab(uri);
    await pollUntil(() => seen.length > 0, "the override to receive the draft", 5000);
    await tick(500);
    assert.deepStrictEqual(seen, [draft], "override must receive the draft exactly once");
    assert.strictEqual(untitledTextTabs().length, 0, "no untitled tab may open");
  });
});
