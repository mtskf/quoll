import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  closeAllEditors,
  getHarness,
  openTempQuoll,
  pollUntil,
  tick,
} from "./harness";
import type { PastePlainMessageShape, RecordedEventShape } from "./types";

// Pin command registration and active-panel routing at the wire; insertion is
// focus-guarded in the webview and covered by the webview paste tests.
const isPastePlainEvent = (
  e: RecordedEventShape
): e is RecordedEventShape & { message: PastePlainMessageShape } =>
  e.message.type === "paste-plain";

const isReadyInbound = (r: { raw: unknown }): boolean =>
  typeof r.raw === "object" &&
  r.raw !== null &&
  (r.raw as { type?: unknown }).type === "ready" &&
  (r.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION;

describe("paste-plain", function () {
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

  it("posts clipboard text to the active panel and nothing after the panel closes", async () => {
    const harness = await getHarness();
    await vscode.env.clipboard.writeText("plain-probe");
    const fixture = await openTempQuoll(harness, "hello\n", "paste-plain", null);
    files.push(fixture.file);

    await pollUntil(
      () => harness.inboundEvents.some(isReadyInbound),
      "the panel's ready handshake"
    );
    harness.clearEvents();

    await vscode.commands.executeCommand("quoll.pastePlain");
    await pollUntil(
      () => harness.events.some(isPastePlainEvent),
      "the host to post paste-plain to the active webview"
    );
    await tick(300);

    const posts = harness.events.filter(isPastePlainEvent);
    assert.strictEqual(posts.length, 1, "exactly one paste-plain must be posted");
    assert.strictEqual(
      posts[0].uri,
      fixture.uri.toString(),
      "the active panel must receive the text"
    );
    assert.strictEqual(
      posts[0].message.text,
      "plain-probe",
      "clipboard text must ride the wire verbatim"
    );
    assert.strictEqual(
      posts[0].message.protocol,
      PROTOCOL_VERSION,
      "the post must carry the current protocol envelope"
    );

    await closeAllEditors();
    await pollUntil(() => harness.activePanel === null, "the panel to dispose");
    // Keep the recorded stream intact so reset cannot hide a stale-panel post.
    await vscode.commands.executeCommand("quoll.pastePlain");
    await tick(300);
    assert.strictEqual(
      harness.events.filter(isPastePlainEvent).length,
      posts.length,
      "a disposed panel must not keep receiving paste-plain messages"
    );
  });
});
