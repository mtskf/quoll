import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isEditorConfigEvent, tick, VIEW_TYPE } from "./harness";
import type { PanelControlsShape, RecordedEventShape, TestHarnessShape } from "./types";

const GUTTER_KEY = "quoll.lint.gutter.enabled";

// Poll `read()` until it returns >= `n` (or the deadline passes). Used to
// observe fan-out / handshake events that accumulate one-per-panel: a single
// waitForEvent would resolve on the FIRST occurrence and could not distinguish
// one webview from two.
async function pollForCount(
  read: () => number,
  n: number,
  label: string,
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (read() >= n) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${n} ${label}; saw ${read()}`);
    }
    await tick(50);
  }
}

// Open a temp .md in Quoll and return the NEWLY-registered panel controls. The
// harness tracks only the most-recently-resolved panel as `activePanel`, so we
// poll until it becomes a panel distinct from `previous` — guarding against
// capturing the prior panel before this openWith's resolve has run.
async function openTempQuoll(
  harness: TestHarnessShape,
  content: string,
  slug: string,
  previous: PanelControlsShape | null
): Promise<{ uri: vscode.Uri; file: string; panel: PanelControlsShape }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `quoll-2panel-${slug}-`));
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

const isReadyInbound = (r: { raw: unknown }): boolean =>
  typeof r.raw === "object" && r.raw !== null && (r.raw as { type?: unknown }).type === "ready";

describe("two-panel-config-caret", function () {
  this.timeout(40000);

  const files: string[] = [];
  let originalGutter: unknown;

  before(async () => {
    await getHarness();
    originalGutter = vscode.workspace.getConfiguration().inspect(GUTTER_KEY)?.globalValue;
  });

  afterEach(async () => {
    const harness = await getHarness();
    await vscode.workspace
      .getConfiguration()
      .update(GUTTER_KEY, originalGutter, vscode.ConfigurationTarget.Global);
    await cleanupBetweenTests(harness);
    await Promise.all(files.splice(0).map((f) => fs.unlink(f).catch(() => undefined)));
  });

  it("fans editor-config out to both webviews and keeps carets per-panel", async () => {
    // Known-off baseline so the flip below is a real false→true edge that fires
    // onDidChangeConfiguration.
    await vscode.workspace
      .getConfiguration()
      .update(GUTTER_KEY, false, vscode.ConfigurationTarget.Global);

    const harness = await getHarness();

    // Two DISTINCT documents → two coexisting Quoll panels.
    const a = await openTempQuoll(harness, "a0\na1\na2\n", "doca", null);
    files.push(a.file);
    const b = await openTempQuoll(harness, "b0\nb1\nb2\nb3\n", "docb", a.panel);
    files.push(b.file);
    assert.notStrictEqual(a.panel, b.panel, "the two panels must be distinct controls");

    // --- (b1) editor-config fan-out to BOTH webviews -------------------------
    // Each panel's real webview posts a ready-driven editor-config (line 910 in
    // quoll-editor-panel.ts) that reads the CURRENT setting. If a ready lands
    // AFTER the flip below it would post lintGutter:true and inflate the count,
    // so wait for BOTH panels' ready handshakes to settle first, then clear.
    await pollForCount(
      () => harness.inboundEvents.filter(isReadyInbound).length,
      2,
      "ready handshakes"
    );
    await tick(200); // let the ready-driven editor-config posts flush
    harness.clearEvents();

    // Flip the gutter setting. Each open panel wires its OWN
    // onDidChangeConfiguration → postEditorConfig, so a working fan-out posts
    // exactly once per panel = two events. A fan-out that only reached the
    // active panel would post one → this goes red.
    await vscode.workspace
      .getConfiguration()
      .update(GUTTER_KEY, true, vscode.ConfigurationTarget.Global);

    const isGutterOn = (e: RecordedEventShape): boolean =>
      isEditorConfigEvent(e) && e.message.lintGutter === true;
    await pollForCount(() => harness.events.filter(isGutterOn).length, 2, "editor-config posts");
    // Let any straggler land, then pin the EXACT fan-out cardinality: one push
    // per panel, no panel missed and no double-post.
    await tick(200);
    assert.strictEqual(
      harness.events.filter(isGutterOn).length,
      2,
      "editor-config(lintGutter:true) must reach both webviews exactly once each"
    );

    // --- (b2) per-panel caret isolation --------------------------------------
    // Report DIFFERENT carets to each panel. lastKnownCaret is a per-panel
    // closure; if it leaked into shared state the last write (docB) would clobber
    // docA's caret and the switch-to-text assertion below would read docB's value.
    a.panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "caret-report",
      line: 1,
      character: 1,
    });
    b.panel.simulateInbound({
      protocol: PROTOCOL_VERSION,
      type: "caret-report",
      line: 3,
      character: 2,
    });
    await tick(50);

    // Switch to docA's default text editor → onDidChangeActiveTextEditor fires
    // for BOTH panels but is uri-filtered, so only panel A applies ITS caret.
    const docA = await vscode.workspace.openTextDocument(a.uri);
    const editorA = await vscode.window.showTextDocument(docA, { preview: false });
    await tick(200);
    assert.strictEqual(editorA.selection.active.line, 1, "docA caret line is panel A's, not B's");
    assert.strictEqual(editorA.selection.active.character, 1, "docA caret character is panel A's");

    // Switch to docB's default text editor → panel B applies its own caret.
    const docB = await vscode.workspace.openTextDocument(b.uri);
    const editorB = await vscode.window.showTextDocument(docB, { preview: false });
    await tick(200);
    assert.strictEqual(editorB.selection.active.line, 3, "docB caret line is panel B's, not A's");
    assert.strictEqual(editorB.selection.active.character, 2, "docB caret character is panel B's");
  });
});
