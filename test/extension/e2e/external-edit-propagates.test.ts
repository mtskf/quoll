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
  isDocumentAfter,
  isDocumentEvent,
  tick,
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

  it("coalesces a burst of lock-free external edits into fewer Document posts (latest wins)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "ext-edit-burst.md");
    await fs.writeFile(tempFile, "# Initial\n\nbody\n");
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const baseVersion = seed.message.docVersion;

    const beforeBurst = Date.now();
    // Fire N separate external edits back-to-back (each its own change event,
    // hence its own documentChanged) with NO webview edit in flight → the
    // panel's write lock is free → every event is debounced. Awaited so all
    // change events fire before we wait out the window; in-memory edits are
    // sub-ms each, so the burst lands well inside DOC_CHANGE_DEBOUNCE_MS.
    const N = 5;
    for (let i = 0; i < N; i++) {
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), `## Burst ${i}\n\n`);
      const ok = await vscode.workspace.applyEdit(edit);
      assert.strictEqual(ok, true, `burst edit ${i} must apply`);
    }

    // Let the trailing debounce fire (100 ms window + generous slack).
    await tick(400);

    const posts = harness.events.filter(
      (e) => isDocumentEvent(e) && e.message.docVersion > baseVersion && e.timestamp >= beforeBurst
    );
    // Discriminating: without the debounce this is exactly N (one post per
    // change event); with it the lock-free burst coalesces to a single trailing
    // post. `< N` is robust to a window-straddle producing 2 while still going
    // red on the un-debounced N.
    assert.ok(
      posts.length >= 1 && posts.length < N,
      `expected 1..${N - 1} coalesced Document posts, got ${posts.length}`
    );
    // Latest wins end-to-end: the final post carries the last burst edit and the
    // highest docVersion observed.
    const last = posts[posts.length - 1];
    assert.ok(isDocumentEvent(last));
    assert.ok(
      last.message.content.startsWith("## Burst 4"),
      `expected latest content to win, got: ${last.message.content.slice(0, 24)}`
    );
    const maxVersion = Math.max(
      ...posts.map((e) => (isDocumentEvent(e) ? e.message.docVersion : 0))
    );
    assert.strictEqual(
      last.message.docVersion,
      maxVersion,
      "final post must carry the max docVersion"
    );
  });

  it("dispatches a lock-held racing external edit immediately (refused settlement posts the live version)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-e2e-"));
    tempFile = path.join(dir, "lock-race.md");
    await fs.writeFile(tempFile, "# Initial\n\nbody\n");
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const baseVersion = seed.message.docVersion;

    // Hold the write lock: the accept arm awaits this deferred; while pending,
    // pendingApplyBaseVersion stays non-null. Resolved `false` at the end to
    // force a REFUSED settlement (which keeps the prior lastAppliedDocVersion,
    // so the posted version is the discriminator).
    const gate = deferred<boolean>();
    let overrideCalled = false;
    harness.applyEditOverride = () => {
      overrideCalled = true;
      return gate.promise;
    };

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after open");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "# webview edit\n\nbody\n",
      baseDocVersion: baseVersion,
    });
    // Vacuity guard: the edit must have acquired the lock (mirrors the guard in
    // write-lock-resync-drops.test.ts). If it were stale-dropped, no lock would
    // be held and the test would prove nothing.
    assert.ok(overrideCalled, "webview edit must enter the accept arm and hold the write lock");

    try {
      await tick(50);
      harness.clearEvents();

      // External edit WHILE the lock is held → the onDidChangeTextDocument
      // handler must dispatch documentChanged IMMEDIATELY (isWriteLockHeld
      // true), resyncing lastAppliedDocVersion to the external version. The
      // reducer defers the post (lock held); the refused settlement below is
      // what actually reposts.
      const beforeExternal = Date.now();
      const ext = new vscode.WorkspaceEdit();
      ext.insert(uri, new vscode.Position(0, 0), "## External\n\n");
      const applied = await vscode.workspace.applyEdit(ext);
      assert.strictEqual(applied, true, "external edit must apply against the writable temp file");

      // Release the lock as REFUSED, immediately (well within the 100 ms
      // debounce window). With the lock-free restriction the external edit was
      // already dispatched, so the refused settlement reposts at the live
      // external version (> baseVersion). Without it (pure debounce) the resync
      // is still pending, so the refused post carries the STALE baseVersion.
      gate.resolve(false);

      const post = await harness.waitForEvent(
        (e) => isDocumentEvent(e) && e.timestamp >= beforeExternal,
        3000
      );
      assert.ok(isDocumentEvent(post));
      assert.ok(
        post.message.docVersion > baseVersion,
        `refused settlement must post the live external version, got ${post.message.docVersion} (base ${baseVersion})`
      );
      assert.ok(
        post.message.content.startsWith("## External"),
        `refused post must carry the live external content, got: ${post.message.content.slice(0, 24)}`
      );
    } finally {
      // Release even if an assertion threw, so the applyEdit.then continuation
      // settles instead of leaking a pending closure into teardown. Idempotent
      // if already resolved above.
      gate.resolve(false);
    }
  });
});
