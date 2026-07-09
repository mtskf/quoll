import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanupBetweenTests, getHarness, VIEW_TYPE } from "./harness";

const KEY = "quoll.lint.problems.enabled";

// Poll vscode.languages.getDiagnostics(uri) until `predicate` holds or the
// deadline passes. Mirrors lint-diagnostics-propagate's waiter: lint crosses
// the boundary asynchronously (webview debounce → post → host convert), and a
// setEnabled toggle re-drives the collection, so polling is the faithful read.
async function waitForDiagnostics(
  uri: vscode.Uri,
  predicate: (diags: readonly vscode.Diagnostic[]) => boolean,
  timeoutMs = 8000
): Promise<readonly vscode.Diagnostic[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const diags = vscode.languages.getDiagnostics(uri);
    if (predicate(diags)) {
      return diags;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out waiting for diagnostics on ${uri.fsPath}; last = ${JSON.stringify(
          diags.map((d) => ({ code: d.code, sev: d.severity, line: d.range.start.line }))
        )}`
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const isQuollLint = (d: vscode.Diagnostic): boolean => d.source === "Quoll";

// Pins the PANEL's config→mirror wiring: the constructor's
// `workspace.onDidChangeConfiguration` handler must route a live toggle of
// quoll.lint.problems.enabled into LintMirror.setEnabled, so the host Problems
// DiagnosticCollection reacts (disable → clear, enable → re-publish from
// cache). lint-mirror.test.ts unit-tests setEnabled in ISOLATION; this E2E is
// the only thing that proves the panel actually forwards the setting to it.
describe("lint-problems-config-toggle", function () {
  this.timeout(40000);

  let tempFile: string | null = null;

  // Capture the EXACT prior global override (not the effective value) so
  // restoring it CLEARS the override for a normally-unset setting instead of
  // pinning an explicit `false`/`true` into the user's global settings.
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
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
      tempFile = null;
    }
  });

  it("live-toggling quoll.lint.problems.enabled clears then re-publishes the Problems mirror", async () => {
    // Known-on starting point (default is true, but pin it so the test does not
    // depend on inherited settings state).
    await vscode.workspace.getConfiguration().update(KEY, true, vscode.ConfigurationTarget.Global);

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-lint-toggle-"));
    tempFile = path.join(dir, "heading-skip.md");
    // h1 -> h3 skips h2: a heading-increment warning on "### Skip" (line 2).
    await fs.writeFile(tempFile, "# Title\n\n### Skip\n");
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    // 1. Enabled (default): the advisory lint reaches Problems.
    const present = await waitForDiagnostics(uri, (ds) => ds.some(isQuollLint));
    assert.ok(present.find(isQuollLint), "expected a Quoll lint diagnostic while enabled");

    // 2. Disable LIVE → the panel's config handler must call setEnabled(false),
    //    which clears the collection. If the panel did NOT forward the toggle,
    //    the diagnostic would persist and this wait times out (non-vacuous).
    await vscode.workspace.getConfiguration().update(KEY, false, vscode.ConfigurationTarget.Global);
    await waitForDiagnostics(uri, (ds) => !ds.some(isQuollLint), 6000);

    // 3. Re-enable LIVE → setEnabled(true) re-publishes every cached document,
    //    so the diagnostic returns without any document edit or reopen.
    await vscode.workspace.getConfiguration().update(KEY, true, vscode.ConfigurationTarget.Global);
    const reenabled = await waitForDiagnostics(uri, (ds) => ds.some(isQuollLint), 6000);
    assert.ok(
      reenabled.find(isQuollLint),
      "re-enabling must re-publish the cached lint into Problems"
    );
  });
});
