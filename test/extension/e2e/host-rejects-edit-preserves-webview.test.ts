import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  hideQuollByOpeningOtherDoc,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

const isEditRejectedEvent = (e: { message: { type: string } }) =>
  e.message.type === "edit-rejected";

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
