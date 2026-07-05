// Regression: a side channel (context-handoff / switch-to-text) fired while a
// flushed edit is still APPLYING on the host must run only AFTER the host's
// applyEdit settles — and must then read the APPLIED document, never the
// pre-edit snapshot.
//
// Mechanism under test: the edit-settled barrier
// (src/extension/edit-settled-barrier.ts, wired in QuollEditorPanel). The
// applyEditOverride APPLIES the real edit but only AFTER a gate the test
// controls, so while the gate is pending the write lock stays held
// (pendingApplyBaseVersion non-null) AND the document is still pre-edit;
// on release the edit lands, then settlement drains the deferred side channel.

import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  deferred,
  getHarness,
  isDocumentEvent,
  tick,
  VIEW_TYPE,
} from "./harness";

// A 40-line edit body — far longer than the 3-line seed, so a line clamp to 40
// is only reachable AFTER the edit applies.
const FORTY_LINES = `${Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

describe("handoff edit-applied barrier", function () {
  this.timeout(30000);

  // Per-test disposable temp fixture — the context-handoff handler save()s a
  // dirty doc, so a source-controlled fixture would be corrupted on disk
  // (mirrors external-fs-write-propagates.test.ts).
  let tempDir: string | null = null;

  // Create a fresh temp .md, open it with the Quoll custom editor, and return
  // its uri. The seed content is short (3 lines) so the applied 40-line clamp
  // is non-vacuous.
  const openTempDoc = async (): Promise<vscode.Uri> => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-barrier-"));
    const tempFile = path.join(tempDir, "barrier.md");
    await fs.writeFile(tempFile, "# seed\n\nbody\n");
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    return uri;
  };

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      tempDir = null;
    }
  });

  it("defers context-handoff until applyEdit settles, then reads the applied lineCount", async () => {
    const harness = await getHarness();
    await openTempDoc();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(200); // quiesce seed/ready

    // Hold the write lock AND apply the real edit only after the gate: the
    // accept arm awaits this override, so pendingApplyBaseVersion stays
    // non-null and the document stays pre-edit until we resolve the gate.
    const gate = deferred<boolean>();
    let overrideCalled = false;
    harness.applyEditOverride = async (edit) => {
      overrideCalled = true;
      await gate.promise;
      return vscode.workspace.applyEdit(edit);
    };

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");

    // Post an edit that reaches the accept arm and acquires the lock.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: FORTY_LINES,
      baseDocVersion: seed.message.docVersion,
    });
    assert.ok(overrideCalled, "edit must enter the accept arm and acquire the write lock");

    // Seed a clipboard sentinel; the context-handoff fallback tier (no Claude
    // Code in the test host) writes the reference to the clipboard — the
    // handoff's terminal observable.
    const sentinel = "quoll-e2e-barrier-sentinel";
    await vscode.env.clipboard.writeText(sentinel);

    try {
      // Fire a SELECTION handoff (endLine 40) WHILE the lock is held.
      panel.simulateInbound({
        protocol: PROTOCOL_VERSION,
        type: "context-handoff",
        hasSelection: true,
        startLine: 1,
        endLine: 40,
      });

      // Deferred: for a bounded window the clipboard must still hold the
      // sentinel (the handoff has not run). Without the barrier it runs
      // immediately and this fails.
      const deferDeadline = Date.now() + 1200;
      while (Date.now() < deferDeadline) {
        assert.strictEqual(
          await vscode.env.clipboard.readText(),
          sentinel,
          "context-handoff must NOT run while the host write lock is held"
        );
        await tick(100);
      }

      // Release: the override applies the 40-line edit, settlement drains the
      // deferred handoff, whose fallback tier writes the reference.
      gate.resolve(true);

      const settleDeadline = Date.now() + 8000;
      let ref = sentinel;
      while (Date.now() < settleDeadline) {
        ref = await vscode.env.clipboard.readText();
        if (ref !== sentinel) {
          break;
        }
        await tick(50);
      }
      assert.notStrictEqual(ref, sentinel, "context-handoff must run AFTER applyEdit settles");
      // Post-edit read: the clamp saw the APPLIED 40-line document. A pre-edit
      // read (3-line seed) would clamp endLine down to 3 → `#L1-3`.
      assert.ok(
        ref.endsWith("#L1-40"),
        `context-handoff must read the applied lineCount (expected …#L1-40, got ${ref})`
      );
    } finally {
      gate.resolve(true); // release even if an assertion threw (settle the .then)
    }
  });

  it("defers switch-to-text until applyEdit settles, then reopens the applied content", async () => {
    const harness = await getHarness();
    const uri = await openTempDoc();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    await tick(200);

    const gate = deferred<boolean>();
    let overrideCalled = false;
    harness.applyEditOverride = async (edit) => {
      overrideCalled = true;
      await gate.promise;
      return vscode.workspace.applyEdit(edit);
    };

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: FORTY_LINES,
      baseDocVersion: seed.message.docVersion,
    });
    assert.ok(overrideCalled, "edit must enter the accept arm and acquire the write lock");

    const isThisDocTextTab = (tab: vscode.Tab): boolean =>
      tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri.toString();
    const hasTextTab = (): boolean =>
      vscode.window.tabGroups.all.some((g) => g.tabs.some(isThisDocTextTab));

    assert.strictEqual(hasTextTab(), false, "precondition: no text tab for the doc yet");

    try {
      // Fire the switch WHILE the lock is held.
      panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });

      // Deferred: no text editor should open for a bounded window.
      const deferDeadline = Date.now() + 1200;
      while (Date.now() < deferDeadline) {
        assert.strictEqual(
          hasTextTab(),
          false,
          "switch-to-text must NOT open the text editor while the host write lock is held"
        );
        await tick(100);
      }

      // Release → override applies the edit → barrier drains → openInTextEditor.
      gate.resolve(true);

      const settleDeadline = Date.now() + 8000;
      while (Date.now() < settleDeadline) {
        if (hasTextTab()) {
          break;
        }
        await tick(50);
      }
      assert.strictEqual(hasTextTab(), true, "switch-to-text must run AFTER applyEdit settles");

      // Post-edit read: the reopened text editor holds the APPLIED content.
      const editor = vscode.window.visibleTextEditors.find(
        (e) => e.document.uri.toString() === uri.toString()
      );
      assert.ok(editor, "the reopened text editor must be visible");
      assert.strictEqual(
        editor.document.getText(),
        FORTY_LINES,
        "switch-to-text must reopen the APPLIED document content"
      );
    } finally {
      gate.resolve(true);
    }
  });
});
