import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  deferred,
  getHarness,
  hideQuollByOpeningOtherDoc,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
  VIEW_TYPE,
} from "./harness";

const isEditRejectedEvent = (e: { message: { type: string } }) =>
  e.message.type === "edit-rejected";

// Temp .md so a swap that reaches finalizeSurfaceSwap's save-then-close (the
// resumption case, and the revert-check of the deferred-race guard) writes to a
// throwaway file instead of mutating a committed fixture.
function tempMd(name: string): vscode.Uri {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quoll-reject-"));
  const p = path.join(dir, name);
  fs.writeFileSync(p, "# Title\n\nbody\n", "utf8");
  return vscode.Uri.file(p);
}

const allTabs = (): vscode.Tab[] => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
const customTab =
  (uri: vscode.Uri) =>
  (t: vscode.Tab): boolean =>
    t.input instanceof vscode.TabInputCustom &&
    t.input.viewType === VIEW_TYPE &&
    t.input.uri.toString() === uri.toString();
const textTab =
  (uri: vscode.Uri) =>
  (t: vscode.Tab): boolean =>
    t.input instanceof vscode.TabInputText && t.input.uri.toString() === uri.toString();

describe("host-rejects-edit-preserves-webview", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("posts edit-rejected (not a reseed Document) when content fails validateMarkdownForWrite", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);

    harness.clearEvents();

    const seededContent = (seed.message as { content: string }).content;
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\n`,
      baseDocVersion: seed.message.docVersion,
    });

    const rejected = await harness.waitForEvent(isEditRejectedEvent, 5000);
    const rejectedMsg = rejected.message as {
      type: "edit-rejected";
      error: { code: string; message: string };
    };
    assert.strictEqual(rejectedMsg.error.code, "unsafe_url");
    assert.match(rejectedMsg.error.message, /javascript:alert\(1\)/);

    const errorMsg = await harness.waitForError(
      (msg) => /Cannot save: .*javascript:alert\(1\)/.test(msg),
      3000
    );
    assert.ok(errorMsg);

    const eventsBeforeRejected = harness.events.slice(0, harness.events.indexOf(rejected));
    const documentSurprise = eventsBeforeRejected.find(isDocumentEvent);
    assert.strictEqual(
      documentSurprise,
      undefined,
      "host posted an unexpected Document before edit-rejected — silent-loss path is still live"
    );
  });

  it("a follow-up Edit with a safe URL succeeds and produces an authoritative Document at the new version", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\n`,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    const fixed = seededContent.replace(/\(javascript:alert\(1\)\)/, "(https://example.com)");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: fixed,
      baseDocVersion: seedV,
    });

    const accepted = await harness.waitForEvent(
      (e) => isDocumentEvent(e) && e.message.docVersion > seedV,
      8000
    );
    const acceptedMsg = accepted.message as unknown as { content: string };
    assert.match(acceptedMsg.content, /https:\/\/example\.com/);
    assert.ok(
      !/javascript:alert\(1\)/.test(acceptedMsg.content),
      "accepted Document still contains the unsafe URL"
    );
  });

  it("ready arrival re-delivers the rejected draft + error (genuine re-init recovery)", async () => {
    // Pairs with the `ready` arm of the rejected-draft barrier in
    // quoll-editor-panel.ts. `ready` fires on a genuine re-init (Fast
    // Refresh / GPU process restart — CodeMirror is EMPTY on the fresh
    // webview) AND on a plain hide → show under `retainContextWhenHidden`
    // (bytes retained). This test simulates the genuine-re-init case by
    // driving `ready` directly via simulateInbound; the host cannot
    // distinguish the two scenarios and re-delivers unconditionally,
    // relying on `applyDocument`'s `needsReseed` guard for idempotency on
    // the retained-content path. The host closure still holds the pending
    // rejection, so the `ready` arm re-delivers the rejected DRAFT (as a
    // Document) + re-raises the rejection banner (edit-rejected) instead
    // of leaving the panel blank until the next accepted Edit / external
    // change.
    const harness = await getHarness();
    await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;
    // Still carries the unsafe URL → rejected; the trailing newline makes
    // it differ from the seed so the verdict is parse-failed, not no-op.
    const draft = `${seededContent}\n`;

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: draft,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);
    await tick(200);
    harness.clearEvents();

    // Drive `ready` directly through the harness's inbound seam — the
    // genuine-re-init handshake. simulateInbound calls handleInbound
    // synchronously, so the ready arm runs in the same tick as this call.
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });

    // The host must re-post the rejected DRAFT (not the disk snapshot) at
    // the UNCHANGED docVersion (no applyEdit ran), so the freshly-mounted
    // webview shows the user's content and future edits keep a matching base.
    const redelivered = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.strictEqual(
      (redelivered.message as { content: string }).content,
      draft,
      "ready re-delivered the disk snapshot instead of the rejected draft — content gap on re-init"
    );
    assert.strictEqual(
      redelivered.message.docVersion,
      seedV,
      "re-delivered Document advanced docVersion — no applyEdit ran, version must be unchanged"
    );

    // ...and re-raise the rejection banner so the user still sees why the
    // draft is unsaved.
    const rejected = await harness.waitForEvent(isEditRejectedEvent, 5000);
    assert.strictEqual(
      (rejected.message as { type: "edit-rejected"; error: { code: string } }).error.code,
      "unsafe_url"
    );

    // A SECOND re-init while the rejection is still unresolved must also
    // re-deliver — `postRejectedDraft` deliberately does NOT clear
    // `pendingRejection`, so the snapshot has to survive the first
    // re-delivery. Pins that contract: a future refactor adding
    // `pendingRejection = null` to `postRejectedDraft` would break the
    // double-re-init scenario and redden this assertion.
    harness.clearEvents();
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    const redelivered2 = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.strictEqual(
      (redelivered2.message as { content: string }).content,
      draft,
      "second ready did not re-deliver the draft — pendingRejection was cleared by postRejectedDraft"
    );
  });

  it("edit-rejected delivery failure clears the pending rejection via the resync fallback", async () => {
    // postEditRejected's ok=false arm falls back to postDocument(), which
    // centrally clears `pendingRejection`. Pins that the new
    // `{ content, error }` snapshot is cleared on this path (not just the
    // boolean era's flag): if postDocument() were ever conditionalised on
    // `pendingRejection`, the fallback would silently deadlock and a later
    // `ready` would wrongly re-deliver the draft.
    const harness = await getHarness();
    await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;
    const draft = `${seededContent}\n`;

    // Force edit-rejected delivery to be refused; everything else is accepted.
    harness.webviewPostMessageOverride = (m) => Promise.resolve(m.type !== "edit-rejected");

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: draft,
      baseDocVersion: seedV,
    });

    // The refused edit-rejected falls back to postDocument() (disk bytes),
    // which clears the snapshot.
    const resync = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.notStrictEqual(
      (resync.message as { content: string }).content,
      draft,
      "fallback resync should ship the disk Document, not the rejected draft"
    );

    // A subsequent `ready` must route through the NORMAL postDocument()
    // (snapshot already cleared), not re-deliver the draft.
    harness.webviewPostMessageOverride = null;
    harness.clearEvents();
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    const normalSeed = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.notStrictEqual(
      (normalSeed.message as { content: string }).content,
      draft,
      "ready after a fallback-cleared rejection re-delivered the draft — snapshot not cleared"
    );
  });

  it("switch-to-text while a rejection is pending is refused — the Quoll tab stays open (draft not orphaned)", async () => {
    // Regression: the switch-to-text arm used to run finalizeSurfaceSwap
    // unconditionally. After a write-gate rejection the user's draft lives
    // ONLY webview-side (the on-disk doc is clean, banner showing), so closing
    // the Quoll tab opened the text editor on the clean disk snapshot and the
    // typed draft was silently lost. The guard now refuses the swap while a
    // rejection is pending: the Quoll tab must remain open, no text tab opens,
    // and the user is told to resolve the problem first.
    const harness = await getHarness();
    const uri = await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seededContent = (seed.message as { content: string }).content;
    // Draft still carries the unsafe URL → rejected; the trailing newline makes
    // it differ from the seed so the verdict is parse-failed, not a no-op.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\n`,
      baseDocVersion: seed.message.docVersion,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    // Now request the surface swap while the rejection is pending.
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });

    // The block surfaces a user-facing message so the button does not look dead.
    const errorMsg = await harness.waitForError(
      (msg) => /can't switch to the text editor/i.test(msg),
      5000
    );
    assert.ok(errorMsg);

    // Give any (erroneous) swap a chance to open a text tab / close the Quoll
    // tab, then assert neither happened.
    await tick(500);
    const tabs = allTabs();
    assert.ok(
      tabs.some(customTab(uri)),
      `Quoll tab must stay open (draft preserved) — ${JSON.stringify(tabs.map((t) => t.label))}`
    );
    assert.ok(
      !tabs.some(textTab(uri)),
      `no text tab must open while the rejection is pending — ${JSON.stringify(
        tabs.map((t) => t.label)
      )}`
    );
  });

  it("reopenInTextEditor command while a rejection is pending is refused — the Quoll tab stays open", async () => {
    // Follow-up to the webview switch-to-text guard (PR #256): the title-bar
    // `quoll.reopenInTextEditor` button and `quoll.toggleEditor`'s to-text case
    // both drive reopenActiveQuollTabAsText, which is TAB-ONLY and has no access
    // to the panel's state.rejection. Without a cross-surface query it would
    // close the Quoll tab on the clean disk snapshot and orphan the rejected
    // draft — exactly the loss the webview arm already blocks. The command path
    // now consults the pending-rejection registry keyed by uri and refuses
    // symmetrically: the Quoll tab stays open and no text tab opens.
    const harness = await getHarness();
    const uri = await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seededContent = (seed.message as { content: string }).content;
    // Draft still carries the unsafe URL → rejected; the trailing newline makes
    // it differ from the seed so the verdict is parse-failed, not a no-op.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\n`,
      baseDocVersion: seed.message.docVersion,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    // Drive the REAL command path (not the webview switch-to-text side channel):
    // the Quoll tab is active after openFixtureWithQuoll, so the command
    // classifies it as the forward swap and hits the registry guard.
    await vscode.commands.executeCommand("quoll.reopenInTextEditor");

    // Give any (erroneous) swap a chance to open a text tab / close the Quoll
    // tab, then assert neither happened.
    await tick(500);
    const tabs = allTabs();
    assert.ok(
      tabs.some(customTab(uri)),
      `Quoll tab must stay open (draft preserved) — ${JSON.stringify(tabs.map((t) => t.label))}`
    );
    assert.ok(
      !tabs.some(textTab(uri)),
      `no text tab must open while the rejection is pending — ${JSON.stringify(
        tabs.map((t) => t.label)
      )}`
    );
  });

  it("deferred switch-to-text is refused when a stash drained by the releasing settlement is rejected", async () => {
    // Regression for the deferred-switch race: the switch-to-text guard checked
    // state.rejection ONLY at message-receipt time. If the switch arrives while
    // the write lock is held it is deferred behind editSettledBarrier; the very
    // settlement that releases the barrier can drain a stashed edit that fails
    // the write-gate, flipping state.rejection to "pending" in the SAME step()
    // that then drains the deferred switch callback. Without a drain-time
    // re-check the switch still closed the Quoll tab, orphaning the just-rejected
    // draft. Uses the same lock-holding seam as pending-edit-dispose-drain.
    const harness = await getHarness();
    const uri = tempMd("deferred-switch.md");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    const doc = panel.document;
    harness.clearEvents();

    const seedV = seed.message.docVersion;

    // Hold edit A's SETTLEMENT open so the write lock stays held while the
    // stash (invalid B) and the switch (deferred) both queue behind it. The
    // real applyEdit still runs immediately, so the document lands on "first".
    const gate = deferred<boolean>();
    let calls = 0;
    harness.applyEditOverride = (edit) => {
      calls += 1;
      if (calls === 1) {
        return vscode.workspace.applyEdit(edit).then((ok) => gate.promise.then(() => ok));
      }
      return vscode.workspace.applyEdit(edit);
    };

    // Edit A (valid) acquires the write lock and applies; settlement held.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "first",
      baseDocVersion: seedV,
    });
    assert.strictEqual(calls, 1, "edit A must acquire the write lock (applyEdit called)");

    // Let edit A land so the drain's canDrain premise (settled doc === inFlight)
    // holds; otherwise the stash is dropped instead of validated.
    const applied1Deadline = Date.now() + 3000;
    while (doc.getText() !== "first" && Date.now() < applied1Deadline) {
      await tick(20);
    }
    assert.strictEqual(doc.getText(), "first", "edit A must land while in flight");

    // Edit B (invalid — unsafe URL) arrives WHILE the lock is held → stashed.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: "[bad](javascript:alert(1))",
      baseDocVersion: seedV,
    });

    // switch-to-text arrives WHILE the lock is held → deferred behind the
    // barrier. The receipt-time rejection is still "none", so the fast-path
    // guard passes and the callback is queued.
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });

    // Release edit A: its settlement drains stash B → parse-failed → rejection
    // pending, then the SAME step drains the deferred switch callback.
    gate.resolve(true);
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    // The deferred switch must be refused by the DRAIN-time re-check: Quoll tab
    // stays open, no text tab opens, the draft is not orphaned.
    await tick(500);
    const tabs = allTabs();
    assert.ok(
      tabs.some(customTab(uri)),
      `Quoll tab must stay open (deferred-switch draft preserved) — ${JSON.stringify(
        tabs.map((t) => t.label)
      )}`
    );
    assert.ok(
      !tabs.some(textTab(uri)),
      `no text tab must open — the deferred switch drained after the stash was rejected — ${JSON.stringify(
        tabs.map((t) => t.label)
      )}`
    );
  });

  it("a rejection arriving during the async open (after both guards pass) still retains the Quoll tab", async () => {
    // Third data-loss window: with no rejection pending, switch-to-text passes
    // both the receipt-time and drain-time guards and calls openInTextEditor —
    // which is async, so its tab-closing success callback runs a tick later.
    // The webview stays live during that open, so a NEW invalid edit can land
    // and flip state.rejection to "pending" in the gap. simulateInbound is
    // synchronous, so the edit below is guaranteed to be processed BEFORE
    // openInTextEditor resolves — deterministically reproducing the race. The
    // success callback must re-check and retain the Quoll tab.
    const harness = await getHarness();
    const uri = tempMd("async-open.md");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;

    // No rejection yet → switch-to-text passes both guards and (lock free) calls
    // openInTextEditor synchronously; its success callback is deferred a tick.
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });

    // Synchronously — before openInTextEditor resolves — an invalid edit lands
    // and fails the write-gate → state.rejection flips to "pending".
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\n[bad](javascript:alert(1))\n`,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    // When the open resolves, the success callback re-checks and RETAINS the
    // Quoll tab (draft not orphaned). The just-opened text tab is an accepted
    // harmless second view here, so this asserts only the data-loss invariant.
    await tick(800);
    const tabs = allTabs();
    assert.ok(
      tabs.some(customTab(uri)),
      `Quoll tab must stay open when a rejection lands during the async open — ${JSON.stringify(
        tabs.map((t) => t.label)
      )}`
    );
  });

  it("switch-to-text resumes normally once a follow-up accepted Edit clears the pending rejection", async () => {
    // Fallthrough coverage: after a rejection clears (an accepted Edit), the
    // guard must let the ordinary forward swap proceed — mirrors the sibling
    // "visible-edge resumes after an accepted Edit clears the flag" convention.
    const harness = await getHarness();
    const uri = tempMd("resume-switch.md");
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;

    // Reject first: an unsafe URL fails the write-gate.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\n[bad](javascript:alert(1))\n`,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    // Resolve with a safe edit — rejection clears to "none".
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\nsafe line\n`,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent((e) => isDocumentEvent(e) && e.message.docVersion > seedV, 8000);

    // Now switch-to-text must proceed like the ordinary forward swap.
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "switch-to-text" });

    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const tabs = allTabs();
      if (tabs.some(textTab(uri)) && !tabs.some(customTab(uri))) {
        break;
      }
      await tick(100);
    }
    const tabs = allTabs();
    assert.ok(!tabs.some(customTab(uri)), "Quoll tab should close once the rejection cleared");
    assert.ok(tabs.some(textTab(uri)), "text tab should open once the rejection cleared");
  });

  it("visible-edge resync is suppressed while a rejected draft is pending", async () => {
    // A bare `panel.webviewPanel.reveal()` on an already-visible panel
    // is a no-op — onDidChangeViewState never fires and the test would
    // pass vacuously. Follow the existing `hidden-webview-resync.test.ts`
    // pattern: open another document first so the Quoll panel actually
    // transitions hidden, then bring the Quoll editor back to focus so
    // the visible-edge path runs.
    const harness = await getHarness();
    await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;

    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\n`,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    // Drain any events that arrive immediately after the rejection
    // (e.g. a spurious `ready` handshake from VS Code on first
    // hide/show with retainContextWhenHidden — see plan Risks) before
    // clearing, so the 500 ms window below only captures
    // onDidChangeViewState-driven Documents.
    await tick(200);
    harness.clearEvents();

    // Hide the Quoll panel by opening + focusing a different document
    // in the same column (mirrors hidden-webview-resync.test.ts). When
    // we re-reveal the Quoll panel, onDidChangeViewState fires its
    // visible-edge transition.
    await hideQuollByOpeningOtherDoc(); // helper imported from harness
    panel.webviewPanel.reveal();

    // Wait long enough for any postDocument microtask to land. If a
    // Document arrives in this window the suppression is broken.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    const surprise = harness.events.find(isDocumentEvent);
    assert.strictEqual(
      surprise,
      undefined,
      "visible-edge posted a Document while a rejected draft was pending — barrier leak"
    );
  });

  it("visible-edge resumes after an accepted Edit clears the flag", async () => {
    // After a successful Edit, the pending rejection is cleared
    // (centrally inside postDocument) and visible-edge transitions
    // resume normal postDocument behaviour.
    const harness = await getHarness();
    await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);
    harness.clearEvents();

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;

    // Reject first.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: `${seededContent}\n`,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    // Resolve with a safe fix.
    const fixed = seededContent.replace(/\(javascript:alert\(1\)\)/, "(https://example.com)");
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: fixed,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent((e) => isDocumentEvent(e) && e.message.docVersion > seedV, 8000);

    harness.clearEvents();
    await hideQuollByOpeningOtherDoc();
    panel.webviewPanel.reveal();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    const resync = harness.events.find(isDocumentEvent);
    assert.ok(
      resync !== undefined,
      "visible-edge did not post a Document after the flag cleared — false positive suppression"
    );
  });
});
