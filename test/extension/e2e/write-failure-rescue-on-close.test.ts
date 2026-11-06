import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  deferred,
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

// Real untitled delivery; other suites install a no-op rescue override.
// Install overrides after the last getHarness() call.

const ORIGINAL = "# Title\n\nbody\n";

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

async function holdDraft(harness: TestHarnessShape, panel: PanelControlsShape) {
  const seed = await harness.waitForEvent(isDocumentEvent, 8000);
  const gate = deferred<boolean>();
  harness.applyEditOverride = () => gate.promise;
  const draft = "# Draft\n\n[bad](javascript:1)\nRESCUE-ME\n";
  panel.simulateInbound({
    protocol: PROTOCOL_VERSION,
    type: "edit",
    editId: 1,
    content: draft,
    baseDocVersion: seed.message.docVersion,
  });
  return { draft, gate };
}

async function closeQuollTab(uri: vscode.Uri): Promise<void> {
  const tab = quollTab(uri);
  assert.ok(tab, "precondition: the Quoll tab is open");
  await vscode.window.tabGroups.close(tab);
}

describe("write-failure-rescue-on-close", function () {
  this.timeout(30000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    await cleanupBetweenTests(await getHarness());
  });

  it("a refused apply settling after close reopens the draft as an untitled Markdown document", async () => {
    assert.strictEqual(untitledTextTabs().length, 0, "precondition: no untitled tab open");
    // Set immediately after the close is requested: only then has a real rescue
    // been started that this case must collect, pass or fail.
    let closedWithRealRescue = false;
    try {
      const { harness, uri, file, panel } = await openQuoll("rescue-real");
      const { draft, gate } = await holdDraft(harness, panel);
      // Real path — after the last getHarness() call (see file header).
      harness.openRescuedDraftOverride = null;

      const closing = closeQuollTab(uri);
      closedWithRealRescue = true;
      await closing;
      gate.resolve(false);

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
        "an untitled tab holding the refused write",
        5000
      );
      const doc = rescuedDoc();
      assert.ok(doc);
      assert.strictEqual(doc.languageId, "markdown", "rescued draft must open as Markdown");
      assert.strictEqual(doc.getText(), draft, "rescued draft must be byte-identical");
      await tick(300);
      assert.strictEqual(
        untitledTextTabs().length,
        1,
        "one failed write creates exactly one rescue"
      );
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

  it("closing a healthy Quoll tab opens nothing", async () => {
    assert.strictEqual(untitledTextTabs().length, 0, "precondition: no untitled tab open");
    try {
      const { harness, uri, panel } = await openQuoll("rescue-control");
      const seed = await harness.waitForEvent(isDocumentEvent, 8000);
      const content = "[saved](javascript:1)\n";
      panel.simulateInbound({
        protocol: PROTOCOL_VERSION,
        type: "edit",
        editId: 1,
        content,
        baseDocVersion: seed.message.docVersion,
      });
      await harness.waitForEvent((e) => isDocumentEvent(e) && e.message.settledEditId === 1, 8000);
      assert.strictEqual(panel.document.getText(), content);
      assert.ok(await panel.document.save());
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
    const { draft, gate } = await holdDraft(harness, panel);
    const seen: string[] = [];
    harness.openRescuedDraftOverride = (content) => {
      seen.push(content);
      return Promise.resolve();
    };

    await closeQuollTab(uri);
    gate.reject(new Error("write failed after dispose"));
    await pollUntil(() => seen.length > 0, "the override to receive the draft", 5000);
    await tick(500);
    assert.deepStrictEqual(seen, [draft], "override must receive the draft exactly once");
    assert.strictEqual(untitledTextTabs().length, 0, "no untitled tab may open");
  });
});
