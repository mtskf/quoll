import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isFormatCommandEvent,
  openTempQuoll,
  pollUntil,
  tick,
} from "./harness";

// Pins the REAL dispatch of `quoll.format`: `executeCommand("quoll.format",
// "bold")` -> the registered command body -> the ACTIVE panel's format poster
// -> a `format-command` message on the wire to that panel's webview, and to no
// other. All five keybindings ride this one command, and unit coverage
// (test/extension/commands/format-command.test.ts) exercises the body against a
// stubbed poster, so this hop — command registration + active-poster placement
// + the actual post — had no observation anywhere.
//
// Routing is proved by the `uri` stamp the harness records alongside each post
// (src/extension/test-harness.ts): `harness.events` is ONE stream shared by
// every panel, so a count alone cannot tell a correctly-routed post from one
// sent to the inactive panel.
//
// WHY THIS STOPS AT THE WIRE (unlike format-document-active-edge.test.ts, which
// asserts the formatted document text): the webview's inline-format command is
// focus-guarded (`view.hasFocus` in cm/inline/inline-formatting-commands.ts) and
// CodeMirror's `hasFocus` requires `document.hasFocus()`. As of 2026-08-10 the
// Electron test host's webview document does not hold focus — verified by
// temporarily posting the focus state back over the caret-report channel: both
// `document.hasFocus()` and `view.hasFocus` read false, before and after an
// active-edge `caret-apply` (whose own `view.focus()` is gated on the same
// `document.hasFocus()`). So no host-driven inline format can mutate bytes here,
// and an assertion on the document text would only pin the guard's no-op — or
// flake with whatever holds OS focus while the suite runs. If that ever changes,
// revisit this test's wire-level scope.
// The byte-level half is pinned where focus is representable instead:
//   - test/webview/shell.test.ts       "shell — format-command routing"
//     (delivered message -> real editor -> `**` markers in the doc)
//   - test/webview/inline/cm-inline-formatting-run-command.test.ts
//     (the focus / read-only guards themselves)
// Together with this test the whole chord path is observed end to end; the only
// unobserved seam is the protocol-validated postMessage boundary.

// Gate the ready handshake on BOTH type and protocol (recordInbound fires
// pre-validator). Mirrors the format-document-active-edge precedent.
const isReadyInbound = (r: { raw: unknown }): boolean =>
  typeof r.raw === "object" &&
  r.raw !== null &&
  (r.raw as { type?: unknown }).type === "ready" &&
  (r.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION;

describe("format-command-dispatch", function () {
  this.timeout(40000);

  const files: string[] = [];

  before(async () => {
    await getHarness();
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    await Promise.all(files.splice(0).map((f) => fs.unlink(f).catch(() => undefined)));
  });

  it("executeCommand('quoll.format', 'bold') posts to the ACTIVE panel's webview only", async () => {
    const harness = await getHarness();

    // Two panels open, B active: one invocation must reach B's webview and only
    // B's — the single-slot active poster, not a broadcast and not a stale
    // registration left behind by A.
    const a = await openTempQuoll(harness, "hello a\n", "cmda");
    files.push(a.file);
    const b = await openTempQuoll(harness, "hello b\n", "cmdb", a.panel);
    files.push(b.file);
    assert.notStrictEqual(a.panel, b.panel, "the two panels must be distinct controls");

    // Both real webviews must have handshaked, so a missing post below means the
    // host never sent one — not that the bundle was still booting.
    await pollUntil(
      () => harness.inboundEvents.filter(isReadyInbound).length >= 2,
      "both panels' ready handshakes"
    );
    harness.clearEvents();

    await vscode.commands.executeCommand("quoll.format", "bold");

    await pollUntil(
      () => harness.events.some(isFormatCommandEvent),
      "the host to post format-command to a webview"
    );
    // Let a second (wrongly broadcast) post land before counting.
    await tick(300);

    const posts = harness.events.filter(isFormatCommandEvent);
    assert.strictEqual(posts.length, 1, "exactly one webview must receive the action");
    assert.strictEqual(
      posts[0].uri,
      b.uri.toString(),
      "the action must go to the ACTIVE panel (B), not the inactive one"
    );
    assert.strictEqual(
      posts.filter((p) => p.uri === a.uri.toString()).length,
      0,
      "the inactive panel must receive nothing"
    );
    assert.strictEqual(posts[0].message.action, "bold", "the action must ride the wire verbatim");
    assert.strictEqual(
      posts[0].message.protocol,
      PROTOCOL_VERSION,
      "the post must carry the current protocol envelope"
    );
  });

  it("posts nothing when no Quoll panel is open (the toast arm, not a stale poster)", async () => {
    const harness = await getHarness();
    // Assert the premise rather than trusting afterEach ordering: a leftover or
    // still-disposing panel would let the negative assertion below pass for the
    // wrong reason (mirrors open-external.test.ts's `assert.ok(panel)` guard).
    assert.strictEqual(harness.activePanel, null, "no panel must be active before this test runs");

    await vscode.commands.executeCommand("quoll.format", "bold");
    await tick(300);
    assert.strictEqual(
      harness.events.filter(isFormatCommandEvent).length,
      0,
      "a disposed panel must not keep receiving format actions"
    );
  });
});
