import * as assert from "node:assert";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

// Pins the inbound validator-reject branch in
// QuollEditorPanel.handleInbound:
//
//   if (!isWebviewToHost(raw)) { console.warn(...); return; }
//
// A wire-malformed payload (here: a `ready` carrying the WRONG protocol
// version — the canonical "protocol-bump mismatch / host-webview bundle
// divergence" case the validator's comment calls out) must be RECEIVED
// by the host (the inbound recorder fires, pre-validator) and then
// silently DROPPED by the validator: no Document reply, no surfaced
// error.
//
// `rawSimulate` (not `simulateInbound`) is required: `simulateInbound`
// routes a typed WebviewToHost straight into `handleInbound`, bypassing
// the inbound recorder, and its parameter type would reject a malformed
// payload at compile time. `rawSimulate` mirrors the real
// onDidReceiveMessage callback — record THEN handle — and takes
// `unknown`, so it can carry the wire-malformed bytes.
//
// Non-vacuity: the PASS arm below is an in-test A/B control — the SAME
// message type with the CORRECT protocol takes the identical
// rawSimulate → handleInbound path and DOES post a Document. The only
// difference is the protocol envelope, so the absence in the DROP arm
// is attributable to the validator, not to a dead pipe. Confirmed by an
// empirical revert (forcing `isProtocolMatch` to return true) — the
// DROP arm's "no Document" assertion reds, the PASS arm stays green.
describe("validator-rejects-malformed", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness(); // force activation before any test runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("records but drops a wire-malformed inbound payload (wrong protocol)", async () => {
    await openFixtureWithQuoll("sample.md");
    const harness = await getHarness();

    // Quiesce the inbound pipe before the absence assertion: wait for
    // the eager seed AND the real webview's one-time `ready` (and let
    // its Document reply land) so the "no Document follows" check below
    // cannot be polluted by the real mount handshake racing our
    // synthetic traffic. The webview stays visible, so no further real
    // inbound arrives after this point.
    await harness.waitForEvent(isDocumentEvent, 8000); // eager seed
    await harness.waitForInbound(
      (e) =>
        typeof e.raw === "object" &&
        e.raw !== null &&
        (e.raw as { type?: unknown }).type === "ready" &&
        (e.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION,
      10000
    ); // real webview ready received
    // Deterministically wait until BOTH expected Documents (eager seed +
    // the one reply to the real webview's one-time ready) are recorded
    // before draining. A blind tick — or a bare waitForEvent, which would
    // match the still-present seed immediately — could let the ready reply
    // land AFTER clearEvents() and pollute the "no Document" assertion.
    for (let i = 0; i < 100 && harness.events.filter(isDocumentEvent).length < 2; i++) {
      await tick(50);
    }
    assert.ok(
      harness.events.filter(isDocumentEvent).length >= 2,
      "real webview never posted its ready→Document reply — bundle may be broken"
    );
    harness.clearEvents();

    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");

    // --- DROP arm: a `ready` with a mismatched protocol version.
    // isWebviewToHost rejects on `!isProtocolMatch`.
    const inboundCountBefore = harness.inboundEvents.length;
    const malformed = { protocol: PROTOCOL_VERSION + 1, type: "ready" };
    panel.rawSimulate(malformed);

    // (a) Received: the inbound recorder fired pre-validator. Search only
    // entries pushed after the snapshot (clearEvents does NOT drain the
    // inbound stream, so a full-history search could match a stale entry).
    const recorded = harness.inboundEvents
      .slice(inboundCountBefore)
      .find(
        (e) =>
          typeof e.raw === "object" &&
          e.raw !== null &&
          (e.raw as { type?: unknown }).type === "ready" &&
          (e.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION + 1
      );
    assert.ok(recorded, "rawSimulate must push the raw payload to the inbound recorder");

    // (b) Dropped: no Document reply follows. This tick is LOAD-BEARING —
    // do NOT remove it. It is the observation window for an erroneously
    // posted async Document: if the validator were bypassed, the `ready`
    // arm would postDocument() through an async postMessage, so the
    // assertion must wait long enough for that erroneous reply to surface.
    // This is exactly what the isProtocolMatch revert-check exercises;
    // without the tick the revert-check cannot observe the reply and the
    // assertion becomes vacuous. The field is quiescent here, so any
    // Document that appears was triggered by this malformed payload.
    await tick(200);
    assert.strictEqual(
      harness.events.filter(isDocumentEvent).length,
      0,
      "validator-rejected payload must not produce a Document reply"
    );

    // (c) Silent: console.warn only — no host error surfaced.
    assert.strictEqual(
      harness.lastError,
      null,
      `validator drop must be silent (got lastError: ${harness.lastError})`
    );

    // --- Additional rejection arms: integration coverage that a null /
    // envelope-malformed payload is ALSO dropped end-to-end (received, no
    // Document), not just the wrong-protocol case above. These pin the
    // host-side path, NOT each pure rejection gate in isolation:
    // `{ type: "ready" }` trips both `!isEnvelopeWithType` AND
    // `!isProtocolMatch` (undefined !== PROTOCOL_VERSION), so the per-gate
    // non-vacuity for isEnvelopeWithType lives in the unit suite
    // (test/shared/protocol.test.ts "isWebviewToHost rejects ..." cases),
    // not here.
    harness.clearEvents();
    panel.rawSimulate(null);
    panel.rawSimulate({ type: "ready" }); // missing protocol field
    await tick(200);
    assert.strictEqual(
      harness.events.filter(isDocumentEvent).length,
      0,
      "null / envelope-malformed payloads must be dropped silently too"
    );

    // --- PASS arm (in-test non-vacuity control): the same message type
    // with the CORRECT protocol takes the identical path and DOES post
    // a Document.
    harness.clearEvents();
    panel.rawSimulate({ protocol: PROTOCOL_VERSION, type: "ready" });
    const reply = await harness.waitForEvent(isDocumentEvent, 5000);
    assert.strictEqual(
      reply.message.type,
      "document",
      "a well-formed ready (same path) must round-trip to a Document"
    );
  });
});
