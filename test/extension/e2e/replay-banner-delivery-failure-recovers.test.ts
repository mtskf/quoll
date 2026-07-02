import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";
import type { DocumentMessageShape, RecordedEventShape } from "./types";

const isEditRejectedEvent = (e: { message: { type: string } }) =>
  e.message.type === "edit-rejected";

// A Document event whose content is NOT the rejected draft. Returned as a
// type-guard so `waitForEvent`'s narrowing flows through to `message.content`.
const isDocumentWithContentOtherThan =
  (notContent: string) =>
  (e: RecordedEventShape): e is RecordedEventShape & { message: DocumentMessageShape } =>
    isDocumentEvent(e) && (e.message as DocumentMessageShape).content !== notContent;

// Codex N6 (failure-aware replay): when a `ready`/`seed` replay re-delivers a
// pending rejection, the banner half of `postRejectedDraft` must be delivered
// FAILURE-AWARE (through `sendEditRejected`, carrying the freshly re-stamped
// delivery id) — NOT via a bare `post`. The replay can fail to deliver (the
// webview detaches mid-reload, a documented-normal `post` outcome). With a bare
// post that failure is dropped silently and the rejection stays stuck pending
// forever: the re-stamp already invalidated the pre-replay `postEditRejected`
// failure that used to recover it, and visible-edge resync is suppressed while
// a rejection is pending. Routing through `sendEditRejected` dispatches
// `editRejectedDeliveryFailed(freshId)` on failure, so the core clears the
// rejection and reseeds a disk Document — recovery instead of a deadlock.
//
// Why E2E (not a vitest unit): the failure-aware delivery lives in the
// `postRejectedDraft` executor — a closure inside `resolveCustomTextEditor`
// that closes over the live `webviewPanel` / `dispatch` and is unreachable from
// a host-session-core unit. The `webviewPostMessageOverride` harness seam,
// driving the real executor, is the only non-vacuous reproduction.
//
// Revert-check: replace `sendEditRejected(effect.error, effect.id)` in the
// `postRejectedDraft` arm with a bare `post(buildEditRejectedMessage(effect.error))`
// and this test goes RED — the failed replay banner produces no recovery signal,
// the rejection stays pending, and the subsequent `ready` re-delivers the draft
// (the final assertion fails).

describe("replay-banner-delivery-failure-recovers (Codex N6 failure-aware replay)", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("a failed `ready` replay banner clears the rejection via the resync fallback (no stuck-pending deadlock)", async () => {
    const harness = await getHarness();
    await openFixtureWithQuoll("unsafe-url.md");
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);

    const panel = harness.activePanel;
    assert.ok(panel);

    const seedV = seed.message.docVersion;
    const seededContent = (seed.message as { content: string }).content;
    // Still carries the unsafe URL → rejected; the trailing newline makes it
    // differ from the seed so the verdict is parse-failed, not no-op.
    const draft = `${seededContent}\n`;

    // (1) Induce a pending rejection: the malformed edit fails
    // validateMarkdownForWrite, so the host raises the rejection banner.
    panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "edit",
      content: draft,
      baseDocVersion: seedV,
    });
    await harness.waitForEvent(isEditRejectedEvent, 5000);

    // Let the initial rejection traffic settle before installing the override,
    // so the override window only governs the replay we drive next.
    await tick(200);
    harness.clearEvents();

    // (2) Fail ONLY the `edit-rejected` (banner) delivery during the replay;
    // the `document` (draft re-delivery) is accepted, preserving the
    // load-bearing Document-before-banner order. Unguarded (bare post): the
    // banner failure is dropped — no recovery. Guarded (sendEditRejected): the
    // failure dispatches `editRejectedDeliveryFailed(freshId)`, clearing the
    // rejection and reseeding a disk Document.
    harness.webviewPostMessageOverride = (m) => {
      // Branch on each load-bearing type explicitly (clearer than a
      // `!== "edit-rejected"` negation): `document` (the draft re-delivery) is
      // accepted so it lands before the banner; `edit-rejected` (the banner) is
      // refused to exercise the failure-aware recovery path. Any other type
      // (e.g. `theme`) is delivered normally via the default — this is intent
      // documentation, not a hardening gate against future protocol types.
      if (m.type === "document") {
        return Promise.resolve(true);
      }
      if (m.type === "edit-rejected") {
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    };

    // (3) `ready` replay: the host re-delivers the rejected DRAFT Document
    // (accepted) then the banner (refused → resync fallback).
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });

    // The resync fallback ships the disk Document (NOT the rejected draft),
    // proving the failed replay banner cleared the rejection rather than
    // leaving it stuck pending. The draft re-delivery Document arrives first
    // (it differs from the disk bytes by the trailing newline), so wait for a
    // Document whose content is the disk snapshot.
    const recovered = await harness.waitForEvent(isDocumentWithContentOtherThan(draft), 5000);
    assert.strictEqual(
      recovered.message.content,
      seededContent,
      "resync fallback should reseed the disk Document (the seed bytes) — failed replay banner left the rejection stuck pending"
    );

    // (4) The panel is no longer stuck: with a healthy surface, a subsequent
    // `ready` routes through the NORMAL postDocument (rejection already
    // cleared), NOT a draft re-delivery. A bare-post regression leaves the
    // rejection pending here, so this `ready` would re-deliver the draft.
    harness.webviewPostMessageOverride = null;
    harness.clearEvents();
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    const normalSeed = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.strictEqual(
      (normalSeed.message as { content: string }).content,
      seededContent,
      "ready after recovery should reseed the disk Document (the seed bytes); a draft re-delivery means the rejection was left stuck pending (bare-post regression)"
    );
  });
});
