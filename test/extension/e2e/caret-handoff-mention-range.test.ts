// Regression: the ⌘⌥K context-handoff reveals a temporary text editor carrying
// the handoff's LINE-RANGE selection, then delegates to Claude Code's zero-arg
// `claude-code.insertAtMentioned`, which reads window.activeTextEditor's
// selection. The caret-handoff wiring's onDidChangeActiveTextEditor tracker
// (activeEditorSub) applies the last-known Quoll caret — a COLLAPSED point — to
// any matching text editor that becomes active, INCLUDING the temp editor the
// reveal itself just opened. If that apply runs before insertAtMentioned reads
// the selection, the range collapses to a caret and the @-mention degrades to
// the whole-file form.
//
// This spec drives the REAL context-handoff path (revealForMention →
// showTextDocument → delegation) and captures window.activeTextEditor.selection
// at the exact moment the delegated command fires, by registering a stand-in
// `claude-code.insertAtMentioned` (absent in the clean test host). The range
// must survive to that read.

import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanupBetweenTests, getHarness, isDocumentEvent, tick, VIEW_TYPE } from "./harness";

const PROTOCOL = 1;
const INSERT_AT_MENTIONED = "claude-code.insertAtMentioned";

describe("caret-handoff does not clobber the ⌘⌥K mention range", function () {
  this.timeout(25000);
  let tempFile: string | null = null;
  let commandReg: vscode.Disposable | null = null;

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    commandReg?.dispose();
    commandReg = null;
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
      tempFile = null;
    }
  });

  it("keeps the reveal's line-range selection through the insertAtMentioned read", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "mention-range.md");
    await fs.writeFile(tempFile, "line0\nline1\nline2\nline3\n");
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(200); // quiesce seed/ready

    // Capture what the delegated insert command actually sees. Claude Code is
    // absent in the clean test host, so this id is free to register.
    type SeenSelection = {
      empty: boolean;
      startLine: number;
      endLine: number;
      endChar: number;
    } | null;
    let resolveSeen: ((seen: SeenSelection) => void) | null = null;
    const seenReady = new Promise<SeenSelection>((r) => {
      resolveSeen = r;
    });
    commandReg = vscode.commands.registerCommand(INSERT_AT_MENTIONED, () => {
      const sel = vscode.window.activeTextEditor?.selection;
      resolveSeen?.(
        sel
          ? {
              empty: sel.isEmpty,
              startLine: sel.start.line,
              endLine: sel.end.line,
              endChar: sel.end.character,
            }
          : null
      );
    });

    const panel = harness.activePanel;
    assert.ok(panel, "activePanel must be set before simulating the handoff");

    // The webview reports a COLLAPSED caret (as it does continuously while the
    // user edits) → host stores it as lastKnownCaret. This is the value the
    // clobber would apply.
    panel.simulateInbound({
      protocol: PROTOCOL,
      type: "caret-report",
      line: 2,
      character: 3,
      selectedChars: 5,
    });
    await tick(50);

    // ⌘⌥K with a multi-line selection (lines 1–3, 1-based) → real reveal +
    // delegation.
    panel.simulateInbound({
      protocol: PROTOCOL,
      type: "context-handoff",
      hasSelection: true,
      startLine: 1,
      endLine: 3,
    });

    const seen = await Promise.race([
      seenReady,
      new Promise<SeenSelection>((_, reject) =>
        setTimeout(() => reject(new Error("insertAtMentioned was never delegated")), 10000)
      ),
    ]);

    assert.ok(seen, "the delegated command must have observed an active text editor");
    assert.strictEqual(
      seen.empty,
      false,
      "the reveal's line-range selection must NOT be collapsed when insertAtMentioned reads it"
    );
    assert.strictEqual(seen.startLine, 0, "range must start at line 0 (1-based line 1)");
    assert.strictEqual(seen.endLine, 2, "range must end at line 2 (1-based line 3)");
    assert.strictEqual(seen.endChar, "line2".length, "range end must reach the end of line 3");
  });

  it("still restores the tracked caret on an ordinary switch AFTER a ⌘⌥K reveal (one-shot)", async () => {
    // Pins that the latch is TRULY one-shot — after a ⌘⌥K reveal consumes it, an
    // ordinary Quoll→text switch still restores the tracked caret (guards against
    // a stranded/over-broad latch).
    //
    // NOTE: the reveal's showTextDocument({selection}) fires the pre-existing
    // selectionSub, which overwrites lastKnownCaret with the reveal's own range
    // endpoint. So we re-report a FRESH, distinct caret (1,2) AFTER the reveal
    // settles — distinct from the first report (2,3) and the reveal endpoint
    // (2,5) — so the assertion can only pass if the ordinary switch actually
    // applied the re-reported caret (latch consumed, not stranded; a stranded
    // latch would skip the apply and leave the fresh editor at its default).
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "mention-range-recovery.md");
    await fs.writeFile(tempFile, "line0\nline1\nline2\nline3\n");
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(200);

    const panel = harness.activePanel;
    assert.ok(panel, "activePanel must be set");
    panel.simulateInbound({
      protocol: PROTOCOL,
      type: "caret-report",
      line: 2,
      character: 3,
      selectedChars: 5,
    });
    await tick(50);

    // First ⌘⌥K reveal — arms + consumes the latch (temp tab opened then closed
    // by cleanup). Let it fully settle so the latch is back to un-armed and the
    // Quoll custom tab is active again.
    panel.simulateInbound({
      protocol: PROTOCOL,
      type: "context-handoff",
      hasSelection: true,
      startLine: 1,
      endLine: 3,
    });
    await tick(800);

    // Re-report a FRESH, distinct caret (the reveal's selectionSub polluted
    // lastKnownCaret to its own range endpoint). This is the value the ordinary
    // switch must restore.
    panel.simulateInbound({
      protocol: PROTOCOL,
      type: "caret-report",
      line: 1,
      character: 2,
      selectedChars: 0,
    });
    await tick(50);

    // Now an ORDINARY Quoll→text switch: the tracked caret must still land (the
    // latch did not strand from the prior reveal).
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await tick(200);

    assert.strictEqual(
      editor.selection.active.line,
      1,
      "caret line restored on the ordinary switch"
    );
    assert.strictEqual(
      editor.selection.active.character,
      2,
      "caret character restored on the ordinary switch"
    );
  });
});
