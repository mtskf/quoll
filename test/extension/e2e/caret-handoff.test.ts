import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanupBetweenTests, getHarness, isDocumentEvent, tick, VIEW_TYPE } from "./harness";

const PROTOCOL = 1;

describe("caret-handoff", function () {
  this.timeout(25000);
  let tempFile: string | null = null;

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
      tempFile = null;
    }
  });

  it("caret-report inbound mutates no document and posts no Document event (reducer bypass)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "caret-bypass.md");
    await fs.writeFile(tempFile, "line0\nline1\nline2\n");
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const seedVersion = seed.message.docVersion;

    const doc = await vscode.workspace.openTextDocument(uri);
    const textBefore = doc.getText();
    const versionBefore = doc.version;
    void seedVersion; // (the seed wait above is the readiness gate)

    // Quiesce first (Codex #2): the eager seed AND the `ready` handshake each
    // post a Document. Let any late ready-response Document arrive BEFORE
    // clearEvents, otherwise it could land after the clear and false-fail the
    // "no Document event" assertion below.
    await tick(300);
    harness.clearEvents();

    // Explicit non-null guard (Codex #3): `activePanel?.` would make this a
    // vacuous pass if the panel were unset (no inbound sent → trivially "no
    // Document, doc unchanged"). Assert it is present so the test cannot
    // silently no-op.
    const panel = harness.activePanel;
    assert.ok(panel, "activePanel must be set before simulating caret-report");
    // Simulate the webview reporting its caret. This must NOT enter the reducer.
    panel.simulateInbound({
      protocol: PROTOCOL,
      type: "caret-report",
      line: 2,
      character: 1,
      selectedChars: 0,
    });
    await tick(200);

    // No Document echo (the side channel never reseeds), and the document is
    // byte-identical at the same version (no Edit / applyEdit happened).
    const docEvents = harness.events.filter((e) => isDocumentEvent(e));
    assert.strictEqual(docEvents.length, 0, "caret-report must not produce a Document event");
    assert.strictEqual(doc.getText(), textBefore, "caret-report must not mutate the document");
    assert.strictEqual(
      doc.version,
      versionBefore,
      "caret-report must not bump the document version"
    );
  });

  it("applies the tracked caret to the live text editor on Quoll→text-editor switch", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "caret-apply.md");
    await fs.writeFile(tempFile, "line0\nline1\nline2\nline3\n");
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);

    // The webview reports a caret while Quoll is active → host stores it.
    const panel = harness.activePanel;
    assert.ok(panel, "activePanel must be set before simulating caret-report");
    panel.simulateInbound({
      protocol: PROTOCOL,
      type: "caret-report",
      line: 2,
      character: 3,
      selectedChars: 0,
    });
    await tick(50);

    // Switch to the DEFAULT text editor for the same uri → host applies the
    // tracked caret to its selection (onDidChangeActiveTextEditor).
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await tick(200);

    const active = editor.selection.active;
    assert.strictEqual(active.line, 2, "caret line carried to the text editor");
    assert.strictEqual(active.character, 3, "caret character carried to the text editor");
  });

  it("posts a caret-apply with the tracked caret on text-editor→Quoll switch (Codex #1)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "caret-push.md");
    await fs.writeFile(tempFile, "line0\nline1\nline2\nline3\nline4\n");
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    const panel = harness.activePanel;
    assert.ok(panel, "activePanel must be set");

    // Open + activate the default text editor → Quoll goes inactive (wasActive
    // resets to false). Then move the text editor's caret → host tracks it via
    // onDidChangeTextEditorSelection (activeTextEditor === this editor).
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await tick(100);
    const target = new vscode.Position(3, 4);
    editor.selection = new vscode.Selection(target, target);
    await tick(100);

    // Switch back INTO Quoll (active edge) → host posts a one-shot caret-apply
    // carrying the tracked caret. Host-observable via the recorded events.
    // (`e.message` is the loose mirror `{ type: string } & Record<string,
    // unknown>`, so `.line` / `.character` read as `unknown` — fine for
    // assert.strictEqual.)
    harness.clearEvents();
    panel.webviewPanel.reveal();
    const evt = await harness.waitForEvent((e) => e.message.type === "caret-apply", 8000);
    assert.strictEqual(evt.message.line, 3, "caret-apply carries the tracked line");
    assert.strictEqual(evt.message.character, 4, "caret-apply carries the tracked character");
  });
});
