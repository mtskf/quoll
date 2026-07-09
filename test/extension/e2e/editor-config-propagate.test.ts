import * as assert from "node:assert";
import * as vscode from "vscode";
import { PROTOCOL_VERSION } from "./constants";
import {
  cleanupBetweenTests,
  getHarness,
  isEditorConfigEvent,
  openFixtureWithQuoll,
  tick,
} from "./harness";

const KEY = "quoll.lint.gutter.enabled";
const SPELLCHECK_KEY = "quoll.editor.spellcheck";

// Gate on BOTH type === "ready" AND the protocol envelope: recordInbound fires
// PRE-validator, so without the protocol check a wire-malformed ready could
// falsely satisfy the handshake gate. Mirrors the two-panel-config-caret test.
const isReadyInbound = (r: { raw: unknown }): boolean =>
  typeof r.raw === "object" &&
  r.raw !== null &&
  (r.raw as { type?: unknown }).type === "ready" &&
  (r.raw as { protocol?: unknown }).protocol === PROTOCOL_VERSION;

// Pins host->webview editor-config delivery: an editor-config is posted at
// seed time (carrying the current setting), and a fresh one is posted when
// quoll.lint.gutter.enabled changes (onDidChangeConfiguration). This is the
// only automated coverage of the three host postEditorConfig call-sites.
describe("editor-config-propagate", function () {
  this.timeout(25000);

  // Capture the EXACT prior global override (not the effective value): a
  // normally-unset setting has globalValue === undefined, and restoring
  // `undefined` CLEARS the override instead of leaving an explicit `false`
  // polluting the user's global settings (Codex review finding 1).
  let originalGlobal: unknown;
  let originalSpellcheck: unknown;

  before(async () => {
    await getHarness();
    originalGlobal = vscode.workspace.getConfiguration().inspect(KEY)?.globalValue;
    originalSpellcheck = vscode.workspace.getConfiguration().inspect(SPELLCHECK_KEY)?.globalValue;
  });

  afterEach(async () => {
    const harness = await getHarness();
    await vscode.workspace
      .getConfiguration()
      .update(KEY, originalGlobal, vscode.ConfigurationTarget.Global);
    await vscode.workspace
      .getConfiguration()
      .update(SPELLCHECK_KEY, originalSpellcheck, vscode.ConfigurationTarget.Global);
    await cleanupBetweenTests(harness);
  });

  it("posts editor-config at seed and again when the setting changes", async () => {
    // Ensure a known starting value (default off) before opening.
    await vscode.workspace.getConfiguration().update(KEY, false, vscode.ConfigurationTarget.Global);

    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");

    // On-open delivery: the panel posts editor-config(lintGutter:false) via the
    // seed and/or ready handshake (NOT isolated — see the NOTE below).
    const onOpen = await harness.waitForEvent(isEditorConfigEvent, 8000);
    assert.strictEqual(
      onOpen.message.lintGutter,
      false,
      "on-open editor-config must carry the default"
    );

    harness.clearEvents();

    // Config-change delivery: flipping the setting posts a fresh editor-config.
    await vscode.workspace.getConfiguration().update(KEY, true, vscode.ConfigurationTarget.Global);
    const changed = await harness.waitForEvent(
      (e) => isEditorConfigEvent(e) && e.message.lintGutter === true,
      8000
    );
    assert.strictEqual(
      changed.message.lintGutter,
      true,
      "config change must re-push editor-config"
    );
  });

  // Sibling of the lint-gutter test above, keyed off quoll.editor.spellcheck.
  // Pins the OTHER editor-surface flag rides the SAME three host
  // postEditorConfig call-sites (seed + ready + onDidChangeConfiguration): a
  // known non-default (false) must arrive on-open, and flipping it back to true
  // must re-push. Non-vacuous against BOTH halves of the wiring — the seed
  // assertion reds if readSpellcheckEnabled() stops being read into the message,
  // and (given the ready-settle below) the change assertion reds if the
  // onDidChangeConfiguration handler stops matching SPELLCHECK_CONFIG_KEY.
  it("posts editor-config carrying the spellcheck flag at seed and again when it changes", async () => {
    // spellcheck defaults ON, so set a known non-default (false) before opening
    // — otherwise the seed assertion would pass vacuously against the default.
    await vscode.workspace
      .getConfiguration()
      .update(SPELLCHECK_KEY, false, vscode.ConfigurationTarget.Global);

    const harness = await getHarness();
    await openFixtureWithQuoll("sample.md");

    const onOpen = await harness.waitForEvent(isEditorConfigEvent, 8000);
    assert.strictEqual(
      onOpen.message.spellcheck,
      false,
      "on-open editor-config must carry the spellcheck setting"
    );

    // Ready-settle BEFORE clear+flip (mirrors two-panel-config-caret). The webview
    // posts a SECOND editor-config from its `ready` handler reading the CURRENT
    // config; `onOpen` resolves on the synchronous seed post, so a `ready`-driven
    // post can still be in flight. If it landed AFTER the flip it would read the
    // now-true config and satisfy the spellcheck===true predicate on its own,
    // making the change-half pass even if onDidChangeConfiguration stopped
    // matching SPELLCHECK_CONFIG_KEY. Waiting for the ready handshake + a flush
    // tick ensures that post is captured and drained by clearEvents, so the only
    // editor-config left to satisfy the predicate is the config-change one.
    await harness.waitForInbound(isReadyInbound, 8000);
    await tick(200);
    harness.clearEvents();

    // Flip false→true → a fresh editor-config carries the new spellcheck value.
    await vscode.workspace
      .getConfiguration()
      .update(SPELLCHECK_KEY, true, vscode.ConfigurationTarget.Global);
    const changed = await harness.waitForEvent(
      (e) => isEditorConfigEvent(e) && e.message.spellcheck === true,
      8000
    );
    assert.strictEqual(
      changed.message.spellcheck,
      true,
      "spellcheck config change must re-push editor-config"
    );
  });
});
