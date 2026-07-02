import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentAfter,
  isDocumentEvent,
  VIEW_TYPE,
} from "./harness";

/**
 * CRLF disk byte-identity (plan §Task 7 step 6).
 *
 * The unit-level CRLF coverage (test/webview/editor.test.ts) pins the CM
 * doc string round-trip via the `lineSeparator` Compartment + `sliceDoc()`
 * read. This e2e proves the END-TO-END contract that the unit test cannot
 * reach: a CRLF file on disk, edited through the real host write path
 * (`workspace.applyEdit` of a whole-document range with the webview's
 * `\r\n` payload), retains its `\r\n` bytes both in the in-memory
 * TextDocument and on disk after save.
 *
 * Scope: uniform-CRLF only. Mixed-EOL is documented-normalized and is
 * NOT asserted here.
 */
describe("crlf-roundtrip", function () {
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

  it("preserves \\r\\n bytes end-to-end through the host write path", async () => {
    // Per-test temp file (mirrors external-edit-propagates) so a mid-test
    // failure does not leave a shared fixture dirty for subsequent tests.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-crlf-"));
    tempFile = path.join(dir, "crlf.md");
    // Initial on-disk bytes: pure CRLF. The trailing CRLF after the last
    // line gives the file two distinct CRLF separators so a single-
    // separator regression (e.g. trailing-line stripped on save) does not
    // hide. Explicit \r\n literals (NOT os.EOL) so the test pins the
    // contract on every platform, not just Windows.
    const originalCrlf = "# CRLF fixture\r\n\r\nbody line one\r\n";
    await fs.writeFile(tempFile, originalCrlf);
    // Sanity-check the disk bytes before VS Code opens the file. Without
    // this guard, a future tmp-fs that silently normalizes EOL on write
    // would surface as a confusing post-edit assertion failure instead
    // of the actual root cause (the write side dropped \r).
    const diskBefore = await fs.readFile(tempFile, "utf8");
    assert.ok(
      diskBefore.includes("\r\n"),
      `fixture write lost \\r\\n on disk; got: ${JSON.stringify(diskBefore)}`
    );

    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    // VS Code detects the file's EOL at open time. Pin that detection so a
    // future platform/VS-Code regression that mis-detects the EOL is
    // surfaced here rather than as a confusing post-edit byte mismatch.
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(
      doc.eol,
      vscode.EndOfLine.CRLF,
      `expected CRLF EOL on opened doc, got ${doc.eol}`
    );

    // Drive an Edit through the REAL host write path: a synthetic inbound
    // `edit` message carrying CRLF content with the seed's docVersion.
    // The host's `case "edit"` arm validates baseDocVersion, builds a
    // whole-document WorkspaceEdit, and applies it via workspace.applyEdit
    // (no override) — i.e. the production write path on real bytes.
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");
    const editedCrlf = "# Edited via webview\r\n\r\nnew body\r\n";
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: editedCrlf,
      baseDocVersion: seed.message.docVersion,
    });

    // Await the post-apply Document (host re-emits on
    // onDidChangeTextDocument with the new content + advanced docVersion).
    // `isDocumentAfter(seed.docVersion)` narrows the predicate so the
    // resolved event's `message.content` is typed as string (not unknown).
    const afterEdit = await harness.waitForEvent(isDocumentAfter(seed.message.docVersion), 5000);
    // In-memory contract: the host-re-emitted Document carries \r\n.
    // Document.content === canonicalDocumentText(document) in postDocument
    // (=== getText() for this uniform-CRLF doc), so this also pins the
    // in-memory buffer's bytes. \r\n preservation here proves the
    // lineSeparator Compartment (editor.ts) + the host write path agree
    // on the contract.
    assert.ok(
      afterEdit.message.content.includes("\r\n"),
      `host re-emitted Document lost \\r\\n; got: ${JSON.stringify(afterEdit.message.content)}`
    );
    assert.ok(
      !/[^\r]\n/.test(afterEdit.message.content),
      `host re-emitted Document has bare \\n (LF-normalized); got: ${JSON.stringify(
        afterEdit.message.content
      )}`
    );
    assert.strictEqual(
      afterEdit.message.content,
      editedCrlf,
      "host re-emitted Document content must match the webview-sent CRLF payload byte-for-byte"
    );

    // Disk-level contract: save the dirty buffer and re-read the file
    // bytes. This pins the FULL end-to-end contract — what lands on disk,
    // not just what the in-memory buffer holds.
    // doc.save() rewrites the file using the TextDocument's eol setting;
    // a regression that flipped doc.eol to LF would surface here as a
    // bare-\n disk read even if the in-memory content above held \r\n.
    const saved = await doc.save();
    assert.strictEqual(saved, true, "doc.save() must succeed for the CRLF temp file");
    const diskAfter = await fs.readFile(tempFile, "utf8");
    assert.strictEqual(
      diskAfter,
      editedCrlf,
      `on-disk bytes did not match the CRLF payload; got: ${JSON.stringify(diskAfter)}`
    );
  });
});
