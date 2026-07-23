import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, tick, VIEW_TYPE } from "./harness";
import type { PanelControlsShape, TestHarnessShape } from "./types";

// Pins the host-side routing of `quoll.formatDocument`: the command forwards a
// single format-document signal to the ACTIVE panel's webview ONLY, which runs
// the real CodeMirror transaction and rides edit-sync back to the host document.
// The count-balance grep in Task 13 proves the doc poster is set/cleared at the
// same edges as the inline-format poster, but it cannot prove PLACEMENT — only a
// two-panel routing run can show the active panel (and only it) is formatted.

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
// pre-validator). Mirrors the two-panel-config-caret precedent.
const isReadyInbound = (r: { raw: unknown }): boolean =>
  typeof r.raw === "object" &&
  r.raw !== null &&
  (r.raw as { type?: unknown }).type === "ready" &&
  (r.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION;

// Open a temp .md in Quoll and return the NEWLY-registered panel controls (poll
// until activePanel becomes distinct from `previous`). Mirrors the sibling tests.
async function openTempQuoll(
  harness: TestHarnessShape,
  content: string,
  slug: string,
  previous: PanelControlsShape | null
): Promise<{ uri: vscode.Uri; file: string; panel: PanelControlsShape }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quoll-fmtdoc-${slug}-`));
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

describe("format-document-active-edge", function () {
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

  it("routes quoll.formatDocument to the ACTIVE panel only; the inactive panel is untouched", async () => {
    const harness = await getHarness();

    // Panel A on an unformatted ordered list; then panel B on another. B active.
    const a = await openTempQuoll(harness, "1. a\n1. b\n", "doca", null);
    files.push(a.file);
    const b = await openTempQuoll(harness, "1. x\n1. y\n", "docb", a.panel);
    files.push(b.file);
    assert.notStrictEqual(a.panel, b.panel, "the two panels must be distinct controls");

    // Both real webviews must have handshaked so runFormatDocument can react.
    await pollUntil(
      () => harness.inboundEvents.filter(isReadyInbound).length >= 2,
      "both panels' ready handshakes"
    );

    // Format the active panel (B). The edit rides the real webview → edit-sync →
    // host document write path.
    await vscode.commands.executeCommand("quoll.formatDocument");
    await pollUntil(
      () => b.panel.document.getText() === "1. x\n2. y\n",
      "panel B formatted (active)"
    );
    assert.strictEqual(
      a.panel.document.getText(),
      "1. a\n1. b\n",
      "inactive panel A must stay byte-untouched"
    );

    // Re-activate A → the command now routes to A only.
    a.panel.webviewPanel.reveal();
    await tick(200);
    await vscode.commands.executeCommand("quoll.formatDocument");
    await pollUntil(
      () => a.panel.document.getText() === "1. a\n2. b\n",
      "panel A formatted after re-activation"
    );
    assert.strictEqual(
      b.panel.document.getText(),
      "1. x\n2. y\n",
      "panel B stays at its already-formatted content (no re-format needed)"
    );
  });
});
