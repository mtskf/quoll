import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  cleanupBetweenTests,
  getHarness,
  isEditorConfigEvent,
  openFixtureWithQuoll,
} from "./harness";

const KEY = "quoll.lint.gutter.enabled";

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

  before(async () => {
    await getHarness();
    originalGlobal = vscode.workspace.getConfiguration().inspect(KEY)?.globalValue;
  });

  afterEach(async () => {
    const harness = await getHarness();
    await vscode.workspace
      .getConfiguration()
      .update(KEY, originalGlobal, vscode.ConfigurationTarget.Global);
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
});
