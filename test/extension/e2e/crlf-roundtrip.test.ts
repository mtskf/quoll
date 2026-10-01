import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  deferred,
  getHarness,
  isDocumentAfter,
  isDocumentEvent,
  makeTempDir,
  tick,
  VIEW_TYPE,
} from "./harness";

/**
 * CRLF disk byte-identity (plan §Task 7 step 6).
 *
 * The unit-level CRLF coverage (test/webview/editor.test.ts) pins the CM doc
 * round-trip via the `quollDocumentEol` Compartment + `serializeDocument`.
 * ⚠️ This e2e injects a hand-built `edit` message and therefore never runs the
 * webview serializer: it gates the HOST's disk write only. The webview side is
 * gated by editor.test.ts's getDoc/liveDoc pairing tests and the wire pin in
 * test/webview/cm-crlf-line-model.test.ts. This e2e proves the END-TO-END
 * contract that neither can reach: a CRLF file on disk, edited through the real
 * host write path
 * (`workspace.applyEdit` of a whole-document range with the webview's
 * `\r\n` payload), retains its `\r\n` bytes both in the in-memory
 * TextDocument and on disk after save.
 *
 * Scope: uniform-CRLF only. Mixed-EOL is documented-normalized and is
 * NOT asserted here.
 *
 * The later cases pin the EOL-mode switch (`TextEdit.setEndOfLine`). The switch
 * alone is not a foreign edit — no reseed goes out for it — and an Edit built on
 * the pre-switch version is still accepted; the webview learns the new EOL from
 * that Edit's ack, whose `eol` field carries the new separator (the webview never
 * infers it). The third case is the Done-when end to end: the switch's debounced
 * `documentChanged` fires first, then keystrokes typed before the switch land on
 * disk in the new EOL. The fourth pins the panel's `ready` wiring: a `ready` that
 * lands before that debounce resyncs on the same epoch. The fifth pins the
 * converse: a host apply breaks the
 * lineage, so an external undo back to the pre-apply text does not let an Edit
 * on the pre-apply version overwrite it. The last two pin the remaining lineage
 * wirings the same way (a visible-edge resync, and the recovery from a failed
 * edit-rejected delivery), each acting from inside the switch's own change event.
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
    const dir = await makeTempDir("crlf");
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
    // in-memory buffer's bytes.
    // ⚠️ Scope, per this file's header: the CRLF payload above is hand-built,
    // so the webview serializer (serializeDocument + the quollDocumentEol
    // Compartment) never ran. What \r\n preservation proves here is the HOST
    // side alone — that the write path carries the bytes it was handed. The
    // webview side is proved by editor.test.ts's getDoc/liveDoc pairing and
    // cm-crlf-line-model.test.ts's wire pin.
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

  it("an EOL-mode switch keeps the webview's lineage: an Edit built before it is accepted and the next Document carries the new eol", async () => {
    // An EOL switch advances the version without changing the text. It must not
    // read as a foreign edit: no reseed goes out for it, and an Edit the webview
    // built on the pre-switch version is still accepted. The webview learns the
    // new EOL from the next Document (here: that Edit's ack). A no-newline doc is
    // the sharp case — its bytes are identical under either EOL.
    const dir = await makeTempDir("eol-switch");
    tempFile = path.join(dir, "no-newline.md");
    await fs.writeFile(tempFile, "a");

    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const doc = await vscode.workspace.openTextDocument(uri);
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel");

    async function setEol(eol: vscode.EndOfLine): Promise<void> {
      const edit = new vscode.WorkspaceEdit();
      edit.set(uri, [vscode.TextEdit.setEndOfLine(eol)]);
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
      assert.strictEqual(doc.eol, eol, `doc.eol after setEndOfLine(${eol})`);
    }

    // Switch, then send an Edit on the PRE-switch version; expect its ack.
    async function switchThenEdit(eol: vscode.EndOfLine, base: number, content: string) {
      await setEol(eol);
      const switched = doc.version;
      assert.ok(switched > base, "setEndOfLine advances the version");
      panel?.simulateInbound({
        protocol: PROTOCOL_VERSION,
        type: "edit",
        content,
        baseDocVersion: base,
      });
      const ack = await harness.waitForEvent(isDocumentAfter(switched), 5000);
      assert.strictEqual(
        ack.message.content,
        content,
        "the pre-switch Edit was applied, not refused"
      );
      assert.strictEqual(ack.message.eol, eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
      assert.strictEqual(ack.message.docVersion, doc.version);
      return ack;
    }

    // Precondition checked, not assumed: a platform default of CRLF would make
    // the CRLF step below a no-op.
    let base = seed.message.docVersion;
    if (doc.eol !== vscode.EndOfLine.LF) {
      base = (await switchThenEdit(vscode.EndOfLine.LF, base, "a0")).message.docVersion;
    }
    base = (await switchThenEdit(vscode.EndOfLine.CRLF, base, "ab")).message.docVersion;
    await switchThenEdit(vscode.EndOfLine.LF, base, "abc");
  });

  it("keystrokes typed before an EOL switch land on disk in the new EOL (Done-when)", async () => {
    // Host body "a\nb"; the webview's Edit "a\nbc" was built before the switch to
    // CRLF (old line endings, pre-switch base). It must be written, in CRLF.
    const dir = await makeTempDir("eol-switch-pending");
    tempFile = path.join(dir, "pending.md");
    await fs.writeFile(tempFile, "a\nb");

    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.eol, vscode.EndOfLine.LF, "fixture opens as LF");
    // Let the open settle (the webview's `ready` resync, view-state posts) so a
    // Document observed below can only come from the switch.
    await tick(400);
    const settled = harness.events.filter(isDocumentEvent).at(-1);
    assert.ok(settled, "no Document after open");
    harness.clearEvents();

    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, [vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF)]);
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    const switched = doc.version;

    // Let the switch's debounced `documentChanged` fire before the Edit arrives
    // (the unsent-buffer path: the keystrokes flush later). It must not reseed:
    // a Document here would carry a new epoch and drop the webview's buffer.
    await tick(400);
    assert.deepStrictEqual(
      harness.events
        .filter(isDocumentEvent)
        .map((e) => ({ docVersion: e.message.docVersion, epoch: e.message.externalEpoch })),
      [],
      "the EOL switch alone must not post a Document"
    );

    harness.activePanel?.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "a\nbc",
      baseDocVersion: settled.message.docVersion,
    });
    const ack = await harness.waitForEvent(isDocumentAfter(switched), 5000);
    assert.strictEqual(ack.message.content, "a\r\nbc");
    assert.strictEqual(
      ack.message.externalEpoch,
      settled.message.externalEpoch,
      "the switch must not advance the epoch"
    );
    assert.strictEqual(await doc.save(), true);
    assert.strictEqual(await fs.readFile(tempFile, "utf8"), "a\r\nbc");
  });

  it("a `ready` landing inside the EOL switch's debounce resyncs without advancing the epoch", async () => {
    const dir = await makeTempDir("eol-switch-ready");
    tempFile = path.join(dir, "ready.md");
    await fs.writeFile(tempFile, "a\nb");

    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    await harness.waitForEvent(isDocumentEvent, 8000);
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.eol, vscode.EndOfLine.LF, "fixture opens as LF");
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel");
    await tick(400); // let the open settle (the webview's own `ready` resync)
    const settled = harness.events.filter(isDocumentEvent).at(-1);
    assert.ok(settled, "no Document after open");
    harness.clearEvents();

    // Send `ready` from inside the switch's own change event: synchronously
    // ahead of the debounced `documentChanged`, so only the ready arm's lineage
    // answer can keep the epoch — no timing involved.
    let readySent = 0;
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== uri.toString()) {
        return;
      }
      sub.dispose();
      readySent++;
      panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    });
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.set(uri, [vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF)]);
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    } finally {
      sub.dispose();
    }
    assert.strictEqual(readySent, 1, "the switch fired no change event to send `ready` from");

    const resync = await harness.waitForEvent(isDocumentAfter(settled.message.docVersion), 5000);
    assert.strictEqual(resync.message.docVersion, doc.version);
    assert.strictEqual(resync.message.eol, "\r\n");
    assert.strictEqual(
      resync.message.externalEpoch,
      settled.message.externalEpoch,
      "the switch must not advance the epoch"
    );
  });

  it("a visible-edge resync landing inside the EOL switch's debounce does not advance the epoch", async () => {
    const dir = await makeTempDir("eol-switch-visible");
    tempFile = path.join(dir, "visible.md");
    await fs.writeFile(tempFile, "a\nb");

    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.eol, vscode.EndOfLine.LF, "fixture opens as LF");
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel");
    // Wait for the webview's own `ready` (and its resync) instead of sleeping.
    await harness.waitForInbound(
      (e) => (e.raw as { type?: unknown } | null)?.type === "ready",
      8000
    );
    const before = doc.version;

    // Real view-state events are VS-Code-timed, so drive the visible-edge resync
    // from inside the switch's own change event: synchronously ahead of the
    // debounced `documentChanged`, so only that dispatch's lineage answer can keep
    // the epoch.
    let fired = 0;
    const sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== uri.toString()) {
        return;
      }
      sub.dispose();
      fired++;
      panel.simulateViewStateVisible();
    });
    try {
      const edit = new vscode.WorkspaceEdit();
      edit.set(uri, [vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF)]);
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    } finally {
      sub.dispose();
    }
    assert.strictEqual(fired, 1, "the switch fired no change event to resync from");

    const resync = await harness.waitForEvent(isDocumentAfter(before), 5000);
    assert.strictEqual(resync.message.docVersion, doc.version);
    assert.strictEqual(resync.message.eol, "\r\n");
    assert.strictEqual(
      resync.message.externalEpoch,
      seed.message.externalEpoch,
      "the switch must not advance the epoch"
    );
  });

  it("an edit-rejected delivery failure landing inside the EOL switch's debounce recovers without advancing the epoch", async () => {
    const dir = await makeTempDir("eol-switch-reject-recovery");
    tempFile = path.join(dir, "reject.md");
    await fs.writeFile(tempFile, "a\nb");

    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const doc = await vscode.workspace.openTextDocument(uri);
    assert.strictEqual(doc.eol, vscode.EndOfLine.LF, "fixture opens as LF");
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel");
    // The real `ready` must land BEFORE the rejection: one arriving while a
    // rejection is pending replays it and re-stamps its delivery id, which would
    // turn the gated failure below into a stale no-op.
    await harness.waitForInbound(
      (e) => (e.raw as { type?: unknown } | null)?.type === "ready",
      8000
    );

    // Park the banner send on a gate so the rejection stays pending.
    const gate = deferred<boolean>();
    let bannerSends = 0;
    harness.webviewPostMessageOverride = (m) => {
      if (m.type === "edit-rejected") {
        bannerSends++;
        return gate.promise;
      }
      return Promise.resolve(true);
    };
    try {
      // Fails the write gate (unsafe URL, same class as fixture unsafe-url.md).
      panel.simulateInbound({
        protocol: PROTOCOL_VERSION,
        type: "edit",
        content: "a\nb\n\n[bad](javascript:alert(1))\n",
        baseDocVersion: seed.message.docVersion,
      });
      // The dispatch chain is synchronous: the banner send is already parked.
      assert.strictEqual(bannerSends, 1, "the edit was not rejected, so no banner send is pending");
      const before = doc.version;

      // Refuse the delivery from inside the switch's own change event:
      // synchronously ahead of the debounced `documentChanged`, so only the
      // recovery's lineage answer can keep the epoch.
      let fired = 0;
      const sub = vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() !== uri.toString()) {
          return;
        }
        sub.dispose();
        fired++;
        gate.resolve(false);
      });
      try {
        const edit = new vscode.WorkspaceEdit();
        edit.set(uri, [vscode.TextEdit.setEndOfLine(vscode.EndOfLine.CRLF)]);
        assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
      } finally {
        sub.dispose();
      }
      assert.strictEqual(fired, 1, "the switch fired no change event to refuse the delivery from");

      const recovered = await harness.waitForEvent(isDocumentAfter(before), 5000);
      assert.strictEqual(recovered.message.content, "a\r\nb");
      assert.strictEqual(recovered.message.docVersion, doc.version);
      assert.strictEqual(recovered.message.eol, "\r\n");
      assert.strictEqual(
        recovered.message.externalEpoch,
        seed.message.externalEpoch,
        "the switch must not advance the epoch"
      );
    } finally {
      harness.webviewPostMessageOverride = null;
    }
  });

  it("an external undo of a host apply is not the same lineage: an Edit on the pre-apply version is refused", async () => {
    // Seed "A"; the webview's Edit "AB" is applied, and an external undo restores
    // "A" before the apply settles. The document visited "AB" — text the webview
    // was never handed — so its pre-apply version no longer describes the live
    // "A". A flush of "ABC" on that version must be stale: the undo wins.
    const dir = await makeTempDir("eol-lineage-undo");
    tempFile = path.join(dir, "undo.md");
    await fs.writeFile(tempFile, "A");

    const uri = vscode.Uri.file(tempFile);
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const harness = await getHarness();
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    const doc = await vscode.workspace.openTextDocument(uri);
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel");
    await tick(400); // let the open settle (the webview's `ready` resync)

    harness.applyEditOverride = async (edit) => {
      harness.applyEditOverride = null;
      assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
      assert.strictEqual(doc.getText(), "AB");
      const undo = new vscode.WorkspaceEdit();
      undo.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(2)), "A");
      assert.strictEqual(await vscode.workspace.applyEdit(undo), true);
      return true;
    };
    try {
      panel.simulateInbound({
        protocol: PROTOCOL_VERSION,
        type: "edit",
        content: "AB",
        baseDocVersion: seed.message.docVersion,
      });
      const ack = await harness.waitForEvent(isDocumentAfter(seed.message.docVersion), 5000);
      assert.strictEqual(ack.message.content, "A", "the external undo won the settlement");

      harness.clearEvents();
      panel.simulateInbound({
        protocol: PROTOCOL_VERSION,
        type: "edit",
        content: "ABC",
        baseDocVersion: seed.message.docVersion,
      });
      await tick(400);
      assert.strictEqual(doc.getText(), "A", "the pre-apply Edit must not overwrite the undo");
    } finally {
      harness.applyEditOverride = null;
    }
  });
});
