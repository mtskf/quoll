import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import { cleanupBetweenTests, getHarness, isEditorConfigEvent, tick, VIEW_TYPE } from "./harness";
import type { PanelControlsShape, RecordedEventShape, TestHarnessShape } from "./types";

const GUTTER_KEY = "quoll.lint.gutter.enabled";
const SPELLCHECK_KEY = "quoll.editor.spellcheck";

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

// Gate on BOTH `type === "ready"` AND the protocol envelope: `recordInbound`
// fires PRE-validator (it records the raw bytes the host may later reject), so
// without the protocol check a wire-malformed ready could falsely satisfy the
// handshake gate. Mirrors the editor-resolves.test.ts precedent.
const isReadyInbound = (r: { raw: unknown }): boolean =>
  typeof r.raw === "object" &&
  r.raw !== null &&
  (r.raw as { type?: unknown }).type === "ready" &&
  (r.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION;

describe("two-panel-config-caret", function () {
  this.timeout(40000);

  const files: string[] = [];
  let originalGutter: unknown;
  let originalSpellcheck: unknown;

  before(async () => {
    await getHarness();
    originalGutter = vscode.workspace.getConfiguration().inspect(GUTTER_KEY)?.globalValue;
    originalSpellcheck = vscode.workspace.getConfiguration().inspect(SPELLCHECK_KEY)?.globalValue;
  });

  afterEach(async () => {
    const harness = await getHarness();
    await vscode.workspace
      .getConfiguration()
      .update(GUTTER_KEY, originalGutter, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration()
      .update(SPELLCHECK_KEY, originalSpellcheck, vscode.ConfigurationTarget.Global);
    await cleanupBetweenTests(harness);
    await Promise.all(files.splice(0).map((f) => fs.unlink(f).catch(() => undefined)));
  });

  it("fans editor-config out to both webviews and keeps carets per-panel", async () => {
    // Known-off baseline so the flip below is a real false→true edge that fires
    // onDidChangeConfiguration.
    await vscode.workspace
      .getConfiguration()
      .update(GUTTER_KEY, false, vscode.ConfigurationTarget.Global);
    // Pin spellcheck to a known value so the fan-out assertions below are
    // deterministic regardless of any pre-existing global override. It is never
    // flipped during this test — every editor-config the panels post must carry
    // this same value, proving the SECOND editor-surface flag fans out alongside
    // lintGutter (a spellcheck-drop in the fan-out reds the assertions below).
    await vscode.workspace
      .getConfiguration()
      .update(SPELLCHECK_KEY, true, vscode.ConfigurationTarget.Global);

    const harness = await getHarness();

    const isGutterOn = (e: RecordedEventShape): boolean =>
      isEditorConfigEvent(e) && e.message.lintGutter === true;
    const isGutterOff = (e: RecordedEventShape): boolean =>
      isEditorConfigEvent(e) && e.message.lintGutter === false;
    // Every editor-config event captured in this test must carry spellcheck:true
    // (set once at the baseline, never changed). Asserts the flag rides the same
    // per-panel fan-out as lintGutter rather than being dropped or defaulted.
    const allCarrySpellcheck = (events: RecordedEventShape[]): boolean =>
      events.every((e) => isEditorConfigEvent(e) && e.message.spellcheck === true);

    // --- (b1) editor-config fan-out proven PER-PANEL by incremental open -----
    // The harness records outbound posts in ONE global stream with no panel
    // attribution, so a bare "count == 2 with two panels" could be satisfied by
    // one panel posting twice while the other stays silent. Instead measure the
    // count as panels are added: one panel must post exactly ONE editor-config,
    // and adding a second must raise it to exactly TWO. That excludes both "only
    // the active panel is reached" (would stay 1) and "one panel double-posts"
    // (single-panel step would already be 2) without panel-tagged events.
    //
    // Each panel's real webview also posts a ready-driven editor-config (line 910
    // in quoll-editor-panel.ts) reading the CURRENT setting; a ready landing after
    // a flip would inflate the count, so wait for the expected number of ready
    // handshakes to settle before clearing and flipping.
    //
    // NOTE: harness.clearEvents() drains only the OUTBOUND `events` stream, not
    // `inboundEvents` (see TestHarness.clearEvents — it clears `_events` alone).
    // So the ready count is cumulative across the whole test: panel A's ready
    // survives the clearEvents() below, and after panel B opens the count reaches
    // 2 (A's retained ready + B's new one) — no per-panel re-handshake is needed.

    // Panel A alone → a gutter flip (false→true) posts exactly ONE.
    const a = await openTempQuoll(harness, "a0\na1\na2\n", "doca", null);
    files.push(a.file);
    await pollForCount(
      () => harness.inboundEvents.filter(isReadyInbound).length,
      1,
      "panel A ready handshake"
    );
    await tick(200); // let panel A's ready-driven editor-config flush
    harness.clearEvents();
    await vscode.workspace
      .getConfiguration()
      .update(GUTTER_KEY, true, vscode.ConfigurationTarget.Global);
    await pollForCount(() => harness.events.filter(isGutterOn).length, 1, "editor-config from A");
    await tick(200);
    assert.strictEqual(
      harness.events.filter(isGutterOn).length,
      1,
      "a single open panel must post exactly one editor-config on a gutter change"
    );
    assert.ok(
      allCarrySpellcheck(harness.events.filter(isGutterOn)),
      "panel A's editor-config must carry spellcheck alongside lintGutter"
    );

    // Add panel B → the SAME flip (true→false) now posts exactly TWO, one per
    // panel. The +1 delta proves the fan-out reaches the newly-opened webview,
    // not just the active panel.
    const b = await openTempQuoll(harness, "b0\nb1\nb2\nb3\n", "docb", a.panel);
    files.push(b.file);
    assert.notStrictEqual(a.panel, b.panel, "the two panels must be distinct controls");
    await pollForCount(
      () => harness.inboundEvents.filter(isReadyInbound).length,
      2,
      "both panels' ready handshakes"
    );
    await tick(200); // let panel B's ready-driven editor-config flush
    harness.clearEvents();
    await vscode.workspace
      .getConfiguration()
      .update(GUTTER_KEY, false, vscode.ConfigurationTarget.Global);
    await pollForCount(
      () => harness.events.filter(isGutterOff).length,
      2,
      "editor-config from both"
    );
    await tick(200);
    assert.strictEqual(
      harness.events.filter(isGutterOff).length,
      2,
      "two open panels must post exactly two editor-config — one per webview"
    );
    assert.ok(
      allCarrySpellcheck(harness.events.filter(isGutterOff)),
      "both panels' editor-config must carry spellcheck alongside lintGutter"
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
