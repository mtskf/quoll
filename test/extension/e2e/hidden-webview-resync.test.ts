import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanupBetweenTests, getHarness, isDocumentEvent, tick, VIEW_TYPE } from "./harness";

describe("hidden-webview-resync", function () {
  this.timeout(25000);

  let tempFile: string | null = null;

  before(async () => {
    await getHarness(); // force activation before any test in this file runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
      tempFile = null;
    }
  });

  it("posts a fresh Document when a hidden panel becomes visible after an external edit", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "hidden.md");
    await fs.writeFile(tempFile, "# Original\n");
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const baseVersion = seed.message.docVersion;

    // Hide Quoll by opening a different document on top.
    const cover = await vscode.workspace.openTextDocument({
      content: "cover",
      language: "plaintext",
    });
    await vscode.window.showTextDocument(cover);
    await tick(200);

    // External edit while hidden. The host's onDidChangeTextDocument
    // handler still ATTEMPTS a Document post, but with
    // retainContextWhenHidden=false VS Code resolves postMessage `false`
    // for a hidden panel, and post-Slice-8a (PR #91) the harness records
    // only posts that resolve `true` — so no Document event is observable
    // here. Do NOT wait for one — the intermediate isDocumentAfter wait
    // timed out exactly as predicted once the cspSource gate stopped
    // masking this suite.
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), "## Hidden insert\n\n");
    const applied = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(applied, true);

    // Let the change-driven post settle, then drain the events log.
    // clearEvents() is still REQUIRED (the slice-8a plan's fallback
    // said to drop it, but waitForEvent matches already-recorded
    // events first — TestHarness.waitForEvent runs
    // `this._events.find(predicate)` before subscribing — so the
    // pre-hide seed Document from the open above would satisfy the
    // post-reveal wait with stale content). The tick also covers
    // platforms where a hidden-time post IS delivered and recorded
    // asynchronously: that Document must be drained too, so the
    // assertion below observes only a visibility-triggered Document.
    await tick(200);
    harness.clearEvents();

    // Re-show Quoll. Use `webviewPanel.reveal()` directly rather than
    // `vscode.openWith`: openWith re-invokes resolveCustomTextEditor
    // (which posts an eager seed Document) — using it here would pass
    // via the resolver re-entry instead of via the visibility transition.
    // reveal() is the surgical trigger: visibility transitions only.
    //
    // NOTE: with `retainContextWhenHidden=true` (set in Task 8 Step 0),
    // hidden panels buffer / receive postMessage calls instead of
    // refusing them, AND the webview is NOT destroyed on hide — it
    // persists in memory. The visible-edge `onDidChangeViewState`
    // handler in quoll-editor-panel.ts is now the sole resync route
    // (the `ready` re-handshake no longer fires on show because the
    // webview was never torn down). This test still drains any
    // hidden-time Document via the `tick + clearEvents` sequence
    // above before the visible-edge assertion, and the
    // `waitForEvent(isDocumentEvent)` below confirms the resync
    // Document carries the post-edit content and docVersion.
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel before re-show");
    panel.webviewPanel.reveal();

    const afterShow = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.ok(
      afterShow.message.content.startsWith("## Hidden insert"),
      `visible-edge Document missing the hidden-time edit; got: ${afterShow.message.content.slice(0, 60)}`
    );
    assert.ok(
      afterShow.message.docVersion > baseVersion,
      "visible-edge Document must carry the post-edit docVersion"
    );
  });
});
