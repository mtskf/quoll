// Out-of-process on-disk edit (a genuine fs.writeFile, as a CLI / external tool
// would do) to a CLEAN document open in a visible Quoll tab must produce a
// higher-docVersion reseed Document posted to the webview — WITHOUT a manual
// reopen.
//
// This is the fs-write → VS Code file watcher → TextDocument auto-revert →
// workspace.onDidChangeTextDocument → reducer reseed path. It is DISTINCT from
// external-edit-propagates.test.ts, which drives the in-session
// vscode.workspace.applyEdit path: that mutates the in-memory TextDocument
// directly and never exercises VS Code's watcher/auto-revert layer. The
// user-reported "stale Quoll tab after a Claude Code CLI edit" bug lived in the
// gap this test now covers — the host never POSTED a reseed Document (the
// platform never reverted), so the webview had nothing to render.
//
// OBSERVATION SCOPE: like external-edit-propagates.test.ts, this asserts on the
// HOST→webview boundary — the reseed Document `post()` the harness records (the
// exact signal the bug suppressed) carrying the on-disk content at a higher
// docVersion. It does NOT assert the webview reducer then re-rendered: the E2E
// host cannot observe the webview's applied state (memory
// quoll-webview-focus-untestable-from-e2e-host), and the reducer's
// non-stale-Document application is already pinned by the webview unit suite
// (src/webview/state.ts tests). Host post = correct coverage for THIS bug.
//
// SCOPE / boundary (see .claude/docs/LEARNING.md "External on-disk edits ..."):
// VS Code auto-reverts an externally-changed backing TextDocument ONLY when it
// is NOT dirty — TextFileEditorModelManager skips the reload of dirty models to
// avoid discarding unsaved edits. A dirty Quoll document (the user made unsaved
// edits — e.g. toggled a checkbox) therefore does NOT reload on an external
// disk change; that is a VS Code platform boundary, not a Quoll-fixable path,
// so it is documented rather than asserted here. This test pins the CLEAN path
// (the common case) so a future change that breaks watcher→reseed propagation
// fails loudly.

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

describe("external-fs-write-propagates", function () {
  this.timeout(20000);

  let tempDir: string | null = null;
  let tempFile: string | null = null;

  before(async () => {
    await getHarness(); // force activation before any test in this file runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    // Remove the whole per-test temp dir (not just the file) so mkdtemp does
    // not leak a directory per run.
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      tempDir = null;
    }
    tempFile = null;
  });

  it("propagates an out-of-process fs.writeFile as a higher-docVersion Document", async () => {
    // Per-test temp dir so a mid-test failure does not leave the shared
    // fixture dirty for subsequent tests (mirrors external-edit-propagates).
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-fswrite-"));
    tempFile = path.join(tempDir, "ext-fs-write.md");
    await fs.writeFile(tempFile, "# Initial\n\nbody\n");
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const baseVersion = seed.message.docVersion;

    // The document must be clean at seed — the reload/auto-revert path VS Code
    // takes only applies to a non-dirty model. Guard the premise so a spurious
    // dirtying regression (an echoed open-time edit) surfaces here, not as a
    // silent timeout below.
    assert.strictEqual(
      harness.activePanel?.document.isDirty,
      false,
      "opening a document in Quoll must not dirty it (a dirty model blocks VS Code's auto-revert)"
    );

    // Anchor BEFORE the external write so a leaked Document with a higher
    // docVersion from an earlier test (the singleton harness.events is shared
    // across panels) cannot satisfy the predicate on its own — same guard as
    // external-edit-propagates.test.ts.
    const beforeExternalWrite = Date.now();

    // Genuine out-of-process write straight to disk: bypasses the in-memory
    // TextDocument model entirely, exactly as an external CLI edit does. VS
    // Code's file watcher detects it and auto-reverts the (clean) backing
    // TextDocument, firing workspace.onDidChangeTextDocument.
    await fs.writeFile(tempFile, "## External\n\n# Initial\n\nbody\n");

    const isDocAfterBaseAfterAnchor = (
      e: RecordedEventShape
    ): e is RecordedEventShape & { message: DocumentMessageShape } =>
      isDocumentAfter(baseVersion)(e) && e.timestamp >= beforeExternalWrite;
    const afterWrite = await harness.waitForEvent(isDocAfterBaseAfterAnchor, 8000);
    assert.ok(
      afterWrite.message.content.startsWith("## External"),
      `reseed Document must carry the on-disk content, got: ${JSON.stringify(
        afterWrite.message.content.slice(0, 32)
      )}`
    );
    assert.ok(
      afterWrite.message.docVersion > baseVersion,
      `expected docVersion > ${baseVersion}, got ${afterWrite.message.docVersion}`
    );
  });
});
