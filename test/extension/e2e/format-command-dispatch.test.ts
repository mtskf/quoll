import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, tick, VIEW_TYPE } from "./harness";
import type { PanelControlsShape, RecordedEventShape, TestHarnessShape } from "./types";

// Pins the REAL dispatch of `quoll.format`: `executeCommand("quoll.format",
// "bold")` -> the registered command body -> the ACTIVE panel's format poster
// -> a `format-command` message on the wire to the real webview. All five
// keybindings ride this one command, and unit coverage
// (test/extension/commands/format-command.test.ts) exercises the body against a
// stubbed poster, so this hop — command registration + active-poster placement +
// the actual post — had no observation anywhere.
//
// WHY THIS STOPS AT THE WIRE (unlike format-document-active-edge.test.ts, which
// asserts the formatted document text): the webview's inline-format command is
// focus-guarded (`view.hasFocus` in cm/inline/inline-formatting-commands.ts) and
// CodeMirror's `hasFocus` requires `document.hasFocus()`. In the Electron test
// host the webview's document NEVER holds focus — measured 2026-08-10 by
// temporarily posting the focus state back over the caret-report channel: both
// `document.hasFocus()` and `view.hasFocus` read false, before and after an
// active-edge `caret-apply` (whose own `view.focus()` is gated on the same
// `document.hasFocus()`). So no host-driven inline format can mutate bytes here,
// and an assertion on the document text would only ever pin the guard's no-op —
// or worse, flake with whatever holds OS focus while the suite runs.
// The byte-level half is pinned where focus is representable instead:
//   - test/webview/shell.test.ts       "shell — format-command routing"
//     (delivered message -> real editor -> `**` markers in the doc)
//   - test/webview/inline/cm-inline-formatting-run-command.test.ts
//     (the focus / read-only guards themselves)
// Together with this test the whole chord path is observed end to end; the only
// unobserved seam is the protocol-validated postMessage boundary.

async function pollUntil(predicate: () => boolean, label: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await tick(50);
  }
}

// Gate the ready handshake on BOTH type and protocol (recordInbound fires
// pre-validator). Mirrors the format-document-active-edge precedent.
const isReadyInbound = (r: { raw: unknown }): boolean =>
  typeof r.raw === "object" &&
  r.raw !== null &&
  (r.raw as { type?: unknown }).type === "ready" &&
  (r.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION;

const isFormatCommandEvent = (e: RecordedEventShape): boolean =>
  e.message.type === "format-command";

// Open a temp .md in Quoll and return its panel controls. `previous` guards the
// second open in a two-panel run: poll until activePanel becomes distinct.
async function openTempQuoll(
  harness: TestHarnessShape,
  content: string,
  slug: string,
  previous: PanelControlsShape | null
): Promise<{ uri: vscode.Uri; file: string; panel: PanelControlsShape }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quoll-fmtcmd-${slug}-`));
  const file = path.join(dir, `${slug}.md`);
  await fs.writeFile(file, content);
  const uri = vscode.Uri.file(file);

  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  const deadline = Date.now() + 8000;
  for (;;) {
    const panel = harness.activePanel;
    if (panel && panel !== previous) {
      return { uri, file, panel };
    }
    if (Date.now() >= deadline) {
      throw new Error(`panel for ${slug} did not register a distinct activePanel`);
    }
    await tick(50);
  }
}

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

  it("executeCommand('quoll.format', 'bold') posts one format-command to the webview", async () => {
    const harness = await getHarness();

    // Two panels open, B active: one command invocation must produce exactly ONE
    // post (the single-slot active poster), not a broadcast to every webview.
    const a = await openTempQuoll(harness, "hello a\n", "cmda", null);
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
      "the host to post format-command to the webview"
    );
    // Let any second (wrongly broadcast) post land before counting.
    await tick(300);

    const posts = harness.events.filter(isFormatCommandEvent);
    assert.strictEqual(posts.length, 1, "exactly one webview must receive the action");
    assert.strictEqual(posts[0].message.action, "bold", "the action must ride the wire verbatim");
    assert.strictEqual(
      posts[0].message.protocol,
      PROTOCOL_VERSION,
      "the post must carry the current protocol envelope"
    );
  });

  it("posts nothing when no Quoll panel is open (the toast arm, not a stale poster)", async () => {
    const harness = await getHarness();
    // No panel opened in this test — cleanupBetweenTests closed the previous
    // one, which must also have cleared the poster. A post here would mean the
    // command still holds a disposed panel's poster.
    await vscode.commands.executeCommand("quoll.format", "bold");
    await tick(300);
    assert.strictEqual(
      harness.events.filter(isFormatCommandEvent).length,
      0,
      "a disposed panel must not keep receiving format actions"
    );
  });
});
