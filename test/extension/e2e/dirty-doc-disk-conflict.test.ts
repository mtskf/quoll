// A DIRTY Quoll document whose backing file is externally rewritten must raise
// a user-confirmed conflict prompt (VS Code skips auto-reverting dirty models —
// see LEARNING.md "2026-07-04: 外部ディスク編集…dirty ドキュメント"). Choosing
// "Reload from disk" must reseed the webview with the on-disk content; choosing
// "Keep my edits" must leave the unsaved buffer untouched.
//
// OBSERVATION SCOPE: asserts on the HOST→webview boundary (the reseed Document
// post the harness records) + the host TextDocument state (isDirty / getText),
// exactly like external-fs-write-propagates.test.ts. The prompt itself is
// observed via the harness `diskConflictPromptOverride` seam, which also injects
// the user's choice (a real modal is unclickable in the headless host).

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

// Kept in sync with src/extension/disk-conflict.ts (the e2e cannot import src/
// under its rootDir); a drift here surfaces as a timed-out prompt wait.
const RELOAD = "Reload from disk";
const KEEP = "Keep my edits";

describe("dirty-doc-disk-conflict", function () {
  this.timeout(20000);

  let tempDir: string | null = null;
  let tempFile: string | null = null;

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
    tempFile = null;
  });

  // Open the temp file in Quoll, seed, then dirty it via an in-session edit that
  // does NOT match disk. Returns the seed docVersion.
  async function openAndDirty(bodyEdit: string): Promise<number> {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-dirty-conflict-"));
    tempFile = path.join(tempDir, "dirty-conflict.md");
    await fs.writeFile(tempFile, "# Initial\n\nbody\n");
    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const baseVersion = seed.message.docVersion as number;

    // Drive a real webview→host edit to dirty the in-memory model.
    harness.activePanel?.simulateInbound({
      protocol: 1,
      type: "edit",
      baseDocVersion: baseVersion,
      content: bodyEdit,
    });
    // The applyEdit → documentChanged reseed advances the version; wait for it
    // so the model is provably dirty before the external write.
    await harness.waitForEvent(isDocumentAfter(baseVersion), 8000);
    assert.strictEqual(
      harness.activePanel?.document.isDirty,
      true,
      "the in-session edit must dirty the model (dirty is the precondition for the conflict path)"
    );
    return baseVersion;
  }

  it("reloads from disk on 'Reload from disk'", async () => {
    const harness = await getHarness();
    await openAndDirty("# Initial\n\nEDITED\n");

    let promptFired: () => void = () => undefined;
    const prompted = new Promise<void>((resolve) => {
      promptFired = resolve;
    });
    harness.diskConflictPromptOverride = (_msg, ..._actions) => {
      promptFired();
      return Promise.resolve(RELOAD);
    };

    const anchor = Date.now();
    // Genuine out-of-process divergent write.
    await fs.writeFile(tempFile as string, "## External\n\n# Initial\n\nbody\n");

    await prompted; // the divergence was detected and the prompt shown

    const reloaded = await harness.waitForEvent(
      (e) =>
        isDocumentAfter(0)(e) &&
        e.timestamp >= anchor &&
        e.message.content.startsWith("## External"),
      8000
    );
    assert.ok(
      (reloaded.message.content as string).startsWith("## External"),
      "Reload must reseed the webview with the on-disk content"
    );
    // Full true-revert contract (Codex C95): the reload is a genuine revert, so
    // the model is clean again and its buffer equals disk — not merely a
    // buffer-overwrite that leaves it dirty. Checked AFTER awaiting the reseed
    // Document above (which fires downstream of the model reload), so isDirty is
    // settled — not the immediate-post-command read Codex C84 flagged as racy. A
    // dirty result here means the revert command silently no-oped and the
    // mechanism must be fixed before ship (do NOT weaken this assertion).
    const doc = harness.activePanel?.document;
    assert.strictEqual(doc?.isDirty, false, "reload must clear the dirty flag (true revert)");
    assert.ok(doc?.getText().startsWith("## External"), "the buffer must hold the on-disk content");
    // No spurious error toast on a SUCCESSFUL reload: the post-condition guard
    // (`document.isDirty` after revert) must not have fired showError (Codex C84 /
    // C3). recordError sets harness.lastError; it stays null on the happy path.
    assert.strictEqual(
      harness.lastError,
      null,
      "a successful reload must not surface an error toast"
    );
  });

  it("keeps unsaved edits on 'Keep my edits'", async () => {
    const harness = await getHarness();
    await openAndDirty("# Initial\n\nKEEPME\n");

    let promptFired: () => void = () => undefined;
    const prompted = new Promise<void>((resolve) => {
      promptFired = resolve;
    });
    harness.diskConflictPromptOverride = (_msg, ..._actions) => {
      promptFired();
      return Promise.resolve(KEEP);
    };

    await fs.writeFile(tempFile as string, "## Other\n\nbody\n");
    await prompted;

    // Let any (erroneous) reload settle, then assert the buffer is untouched.
    await new Promise((r) => setTimeout(r, 400));
    const doc = harness.activePanel?.document;
    assert.ok(doc?.getText().includes("KEEPME"), "unsaved edits must be preserved");
    assert.strictEqual(doc?.isDirty, true, "the model must stay dirty (no silent revert)");
    // NOTE: the save-conflict guard on a subsequent save is VS Code-native — on
    // "Keep my edits" the panel is a pure no-op, so nothing Quoll-side can
    // weaken it. We deliberately do NOT drive `doc.save()` here: under a save
    // conflict it surfaces a modal the headless E2E host cannot dismiss (hang
    // risk), and asserting VS Code's own guard tests the platform, not Quoll
    // (Codex C88 — acknowledged). The dirty + preserved-buffer assertions above
    // pin the Quoll-owned contract: the divergence never silently discarded the
    // user's edits, so the stale etag that triggers the native guard is intact.
  });
});
