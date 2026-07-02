import * as assert from "node:assert";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isDocumentEvent,
  openFixtureWithQuoll,
  VIEW_TYPE,
} from "./harness";

describe("editor-resolves", function () {
  this.timeout(20000);

  before(async () => {
    await getHarness(); // force activation before any test runs
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
  });

  it("resolves the Quoll custom editor for a .md file", async () => {
    await openFixtureWithQuoll("sample.md");

    const harness = await getHarness();
    // Panel posts the eager seed Document in resolveCustomTextEditor —
    // its arrival proves the custom editor resolved.
    const seed = await harness.waitForEvent(isDocumentEvent, 8000);
    assert.strictEqual(seed.message.type, "document");

    // VS Code's tab API confirms the active tab claims the Quoll view type.
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    assert.ok(tab, "no active tab");
    assert.ok(
      tab.input instanceof vscode.TabInputCustom,
      `active tab is not a custom editor: ${tab.input?.constructor.name}`
    );
    assert.strictEqual((tab.input as vscode.TabInputCustom).viewType, VIEW_TYPE);
  });

  it("real webview bundle loads and posts ready (CSP-clean)", async () => {
    // SMOKE: a broken webview bundle (CSP, ESM/CJS mismatch, missing
    // script asset) would still pass the assertion above because the
    // panel posts the eager seed regardless of webview load success.
    // This catches that class of regression by waiting for an actual
    // inbound `ready` from the real webview process.
    await openFixtureWithQuoll("sample.md");

    const harness = await getHarness();
    // Predicate gates on both `type === "ready"` AND the protocol
    // envelope so a webview that posts a wire-malformed ready (which
    // the host would have validator-dropped) does not falsely satisfy
    // the smoke. `recordInbound` fires pre-validator, so without the
    // protocol check the smoke would pass on host-rejected bytes.
    const ready = await harness.waitForInbound(
      (e) =>
        typeof e.raw === "object" &&
        e.raw !== null &&
        (e.raw as { type?: unknown }).type === "ready" &&
        (e.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION,
      10000
    );
    assert.ok(ready, "real webview never posted ready — bundle is broken");

    // CSP-clean assertion:
    //
    // Why this signal: webview-side CSP violations land in the iframe's
    // dev-tools console / `securitypolicyviolation` event — neither is
    // observable from the extension host process via the `vscode.*` API
    // (no console-capture, no DOM access, no securitypolicyviolation
    // hook on WebviewPanel). The plan's three suggested signals (console
    // capture, securitypolicyviolation event, computed-style probe) all
    // require either webview DOM access or webview-side instrumentation,
    // neither of which this task's boundary allows (no production-code
    // changes outside the temp revert-check).
    //
    // Strongest signal reachable from the host alone: combine the
    // ready-arrived smoke above with a same-bundle round-trip — drive a
    // synthetic `ready` and require the host's reply Document to land
    // within deadline. A webview broken by a CSP-blocked theme/highlight
    // <style> could still post its initial `ready` (script-src nonce is
    // independent of style-src), but a fully-broken React tree often
    // throws during the post-mount StrictMode replay and the subsequent
    // round-trip becomes flaky/timeouts. This is NECESSARY-not-sufficient
    // coverage; the strong directional proofs live in two unit tests:
    //   - test/extension/webview-html.test.ts pins `style-src` carries
    //     the nonce admission.
    //   - test/webview/editor.test.ts pins Editor stamps the nonce on
    //     CodeMirror via EditorView.cspNonce.
    // Together with the round-trip smoke here, they constitute defense-
    // in-depth for CSP nonce coverage — see plan §Task 7 step 5.
    //
    // Revert-check coverage (plan §Task 7 step 5): an empirical revert
    // (commenting out `EditorView.cspNonce.of(nonce)` and re-running
    // this suite) does NOT red the round-trip below — CSP-blocked CM
    // <style> elements degrade the editor's VISUAL rendering only,
    // while ready, the round-trip, and lastError remain clean (script-
    // src nonce is independent of style-src, and postMessage is
    // unaffected). The unit-level reds (webview-html.test.ts +
    // editor.test.ts above) are the load-bearing signal for CSP nonce
    // coverage — the e2e here adds a same-bundle smoke that catches the
    // broader class of bundle-load regressions (script asset 404,
    // ESM/CJS mismatch, script-src nonce drift) for which it does red
    // on revert.
    //
    // Probe: a synthetic `ready` round-trip must reply with a Document
    // within the timeout. clearEvents() drains the eager seed so the
    // wait is unambiguously the post-synthetic reply (mirrors the
    // anchor pattern in ready-handshake.test.ts).
    harness.clearEvents();
    const panel = harness.activePanel;
    assert.ok(panel, "no active panel after openFixtureWithQuoll");
    panel.simulateInbound({ protocol: PROTOCOL_VERSION, type: "ready" });
    const reply = await harness.waitForEvent((e) => e.message.type === "document", 5000);
    assert.strictEqual(
      reply.message.type,
      "document",
      "real bundle failed to round-trip a ready→Document — possible CSP/load regression"
    );
    // No host-side error surfaced during the seed→ready→synthetic-reply
    // window. A panel that observed a malformed inbound (e.g. a
    // webview attempting recovery after CSP-broken styles via a
    // non-protocol diagnostic) would set lastError via the validator's
    // warn path or the inbound handler's error arms. Asserting null here
    // pins that the only inbound traffic across the window matched the
    // protocol (which the inbound-ready predicate above also pinned).
    assert.strictEqual(
      harness.lastError,
      null,
      `unexpected host-side error during real-bundle window: ${harness.lastError}`
    );
  });
});
