import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanupBetweenTests, getHarness, isDocumentEvent, VIEW_TYPE } from "./harness";

/**
 * Mixed / CR-only EOL round-trip (TODO: webview-mixed-eol-roundtrip).
 *
 * Two distinct contracts (Codex finding 5 — do not conflate core-API save
 * with the webview seam round-trip):
 *
 *  1. HOST SEEDS UNIFORM: postDocument() sends buildDocumentMessageFromDocument
 *     (content = canonicalDocumentText(document)); combined with VS Code's
 *     load-time EOL normalization the seed the webview receives is uniform
 *     (one separator matching document.eol). The webview seam never sees
 *     mixed/CR-only text.
 *  2. OPEN -> NO-OP SAVE IS BYTE-IDENTICAL: opening does not dirty the buffer
 *     (isDirty === false), so save() does not rewrite it; the original
 *     mixed / CR-only bytes survive on disk untouched (byte-level Buffer
 *     comparison).
 *
 * The webview-seam round-trip (seed -> applyDocument -> sliceDoc) is pinned by
 * the unit suite (test/webview/editor.test.ts). Disk normalization on EDIT is
 * VS Code's own behavior (the loaded model is already uniform), out of scope.
 */
describe("mixed-eol-roundtrip", function () {
  this.timeout(20000);

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

  async function assertContract(originalBytes: Buffer): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-mixedeol-"));
    tempFile = path.join(dir, "doc.md");
    // `as Uint8Array` bridges a Buffer<ArrayBuffer> vs Uint8Array<ArrayBufferLike>
    // invariance in @types/node@20.16.0 + TS 5.9 (fs/Buffer.equals signatures);
    // the runtime values are real Buffers, so byte-level .equals() is preserved.
    await fs.writeFile(tempFile, originalBytes as Uint8Array);
    const diskBefore = await fs.readFile(tempFile);
    assert.ok(
      diskBefore.equals(originalBytes as Uint8Array),
      "fixture write mutated the on-disk bytes"
    );

    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const doc = await vscode.workspace.openTextDocument(uri);

    // Contract 1: seed is uniform (single separator matching doc.eol). Uses a
    // split/join round-trip (NOT a regex) so a leading bare LF cannot slip
    // through (Codex finding 4).
    const sep = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    assert.strictEqual(
      seed.message.content,
      seed.message.content.split(/\r\n|\r|\n/).join(sep),
      `host seed must be uniform; got: ${JSON.stringify(seed.message.content)}`
    );
    assert.strictEqual(doc.isDirty, false, "opening must not dirty the buffer");

    // Contract 2: open -> no-op save (no edit) leaves disk bytes untouched.
    const saved = await doc.save();
    assert.strictEqual(saved, true, "doc.save() should resolve true");
    const diskAfter = await fs.readFile(tempFile);
    assert.ok(
      diskAfter.equals(originalBytes as Uint8Array),
      `open -> no-op save mutated disk bytes; got: ${JSON.stringify(diskAfter.toString("utf8"))}`
    );
  }

  it("mixed CRLF+LF: host seeds uniform & no-op save preserves disk bytes", async () => {
    await assertContract(Buffer.from("# H\r\n\r\nbody lf\nbody crlf\r\n", "utf8"));
  });

  it("CR-only: host seeds uniform & no-op save preserves disk bytes", async () => {
    await assertContract(Buffer.from("# H\r\rbody one\rbody two\r", "utf8"));
  });
});
