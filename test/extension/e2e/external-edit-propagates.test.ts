import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentAfter,
  isDocumentEvent,
  VIEW_TYPE,
} from "./harness";
import type { DocumentMessageShape, RecordedEventShape } from "./types";

describe("external-edit-propagates", function () {
  this.timeout(20000);

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

  it("propagates an externally-applied WorkspaceEdit as a higher-docVersion Document", async () => {
    // Per-test temp file so a mid-test failure does not leave the
    // shared fixture dirty for subsequent tests.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "ext-edit.md");
    await fs.writeFile(tempFile, "# Initial\n\nbody\n");
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const baseVersion = seed.message.docVersion;

    // Anchor BEFORE triggering applyEdit so a leaked Document with a
    // higher docVersion from an earlier test (singleton harness.events
    // is shared across panels) cannot satisfy isDocumentAfter alone.
    // RecordedEvent.timestamp is Date.now() inside recordEvent, which
    // now fires asynchronously inside the postMessage(.then(ok=>...)) success
    // arm (Slice 8a follow-up). Monotonic time still guarantees
    // e.timestamp >= beforeExternalEdit for posts triggered after this
    // anchor, so the predicate semantics hold; the anchor is just no
    // longer "synchronous with post()".
    const beforeExternalEdit = Date.now();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(uri, new vscode.Position(0, 0), "## External\n\n");
    const applied = await vscode.workspace.applyEdit(edit);
    assert.strictEqual(applied, true, "external applyEdit must succeed against a writable file");

    const isDocAfterBaseAfterAnchor = (
      e: RecordedEventShape
    ): e is RecordedEventShape & { message: DocumentMessageShape } =>
      isDocumentAfter(baseVersion)(e) && e.timestamp >= beforeExternalEdit;
    const afterEdit = await harness.waitForEvent(isDocAfterBaseAfterAnchor, 5000);
    assert.ok(afterEdit.message.content.startsWith("## External"));
    assert.ok(
      afterEdit.message.docVersion > baseVersion,
      `expected docVersion > ${baseVersion}, got ${afterEdit.message.docVersion}`
    );
  });
});
