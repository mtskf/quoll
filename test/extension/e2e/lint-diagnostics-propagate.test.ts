import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { cleanupBetweenTests, getHarness, VIEW_TYPE } from "./harness";

// Poll vscode.languages.getDiagnostics(uri) until `predicate` holds or the
// deadline passes. Lint is debounced (250ms) in the webview, then posted across
// the boundary and converted host-side, so the steady state is reached
// asynchronously — polling (not a single read) is the faithful assertion.
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

describe("lint-diagnostics-propagate", function () {
  this.timeout(40000);

  let tempFile: string | null = null;

  before(async () => {
    await getHarness(); // force activation
  });

  afterEach(async () => {
    const harness = await getHarness();
    await cleanupBetweenTests(harness);
    if (tempFile) {
      await fs.unlink(tempFile).catch(() => undefined);
      tempFile = null;
    }
  });

  it("mirrors lint into Problems with correct range, updates on fix, reopens, clears on close", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-lint-e2e-"));
    tempFile = path.join(dir, "heading-skip.md");
    // h1 -> h3 skips h2: heading-increment (MD001-equivalent) warning on "### Skip".
    await fs.writeFile(tempFile, "# Title\n\n### Skip\n");
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    // 1. Appears with correct source/severity/code/range.
    const present = await waitForDiagnostics(uri, (ds) => ds.some(isQuollLint));
    const lint = present.find(isQuollLint);
    assert.ok(lint, "expected a Quoll lint diagnostic");
    assert.strictEqual(lint.source, "Quoll");
    assert.strictEqual(lint.code, "heading-increment");
    assert.strictEqual(
      lint.severity,
      vscode.DiagnosticSeverity.Warning,
      "advisory lint must be Warning, never Error"
    );
    // "### Skip" is on line index 2 (0-based). The line/character wire must land there.
    assert.strictEqual(lint.range.start.line, 2, "diagnostic must point at the offending heading");

    // 2. Fix the violation (h3 -> h2): the diagnostic clears.
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, doc.lineAt(2).range, "## Skip");
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);
    await waitForDiagnostics(uri, (ds) => !ds.some(isQuollLint));

    // Re-introduce the violation so a Quoll diagnostic is PRESENT at close
    // time — otherwise the close→clear assertion below is vacuous (the fix
    // above already cleared it). This makes "clears on dispose" the real signal.
    const reintro = new vscode.WorkspaceEdit();
    reintro.replace(uri, doc.lineAt(2).range, "### Skip");
    assert.strictEqual(await vscode.workspace.applyEdit(reintro), true);
    await waitForDiagnostics(uri, (ds) => ds.some(isQuollLint));

    // 3. Close the editor: the document's diagnostics are cleared on dispose.
    //    Assert on the absence of OUR provider's entries (not ds.length === 0):
    //    getDiagnostics(uri) aggregates every provider, so a length check would
    //    spuriously fail if another extension annotates the same uri.
    //    revertAllFiles is best-effort — not available in all VS Code builds
    //    (e.g. 1.94); applyEdit only changed the in-memory buffer so the on-disk
    //    file still has the heading-skip content, meaning closing and reopening
    //    will re-read the violation from disk regardless.
    try {
      await vscode.commands.executeCommand("workbench.action.revertAllFiles");
    } catch {
      // best-effort; silently absent in some VS Code builds
    }
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await waitForDiagnostics(uri, (ds) => !ds.some(isQuollLint), 5000);

    // 4. Reopen the same uri: the collection re-populates (provider-owned
    //    collection survives, the new panel sets this uri afresh).
    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
    const reopened = await waitForDiagnostics(uri, (ds) => ds.some(isQuollLint));
    assert.ok(reopened.find(isQuollLint), "reopening must re-populate Problems");
  });

  it("maps ranges correctly for a CRLF document (line/character is EOL-invariant)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-lint-crlf-"));
    tempFile = path.join(dir, "crlf.md");
    // Same violation, CRLF line endings. An offset-based wire would mis-place
    // the range (CM is LF-internal, the TextDocument is CRLF); line/character
    // must land on line index 2 regardless.
    await fs.writeFile(tempFile, "# Title\r\n\r\n### Skip\r\n");
    const uri = vscode.Uri.file(tempFile);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    const present = await waitForDiagnostics(uri, (ds) => ds.some(isQuollLint));
    const lint = present.find(isQuollLint);
    assert.ok(lint, "expected a Quoll lint diagnostic on the CRLF document");
    assert.strictEqual(
      lint.range.start.line,
      2,
      "CRLF must not shift the diagnostic line (line/character is EOL-invariant)"
    );
  });

  // A violation introduced AFTER open must surface at the correct line. This
  // drives the dynamic path host-side (external applyEdit → onDidChangeTextDocument
  // → host reseeds the webview → webview re-lints → re-posts), exercising
  // "appears when a lint issue is created" rather than only "present at open".
  //
  // NOTE on the webview-ORIGINATED-edit staleness case (typing in the editor
  // creates the violation, then the host ack is byte-identical so no reseed
  // fires): that path is NOT drivable from the E2E host (the webview's CodeMirror
  // surface cannot be typed into from the extension-host process — see the
  // webview-focus E2E limitation). Its correctness rests on two unit-pinned
  // guarantees instead: toWireDiagnostics maps offsets→line/character correctly
  // (Task 3) and toLintDiagnostics is host-document-independent (Task 2), so the
  // host reproduces exactly the ranges the webview computed for its content.
  it("surfaces a violation introduced by an external edit, at the correct line", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "quoll-lint-dyn-"));
    tempFile = path.join(dir, "baseline.md");
    // Line 0 carries a single trailing space → a STABLE `no-trailing-spaces`
    // finding (a single trailing space is flagged; only exactly two on a
    // terminated line is the exempt hard break). It is the non-vacuous baseline
    // anchor: observing it proves the webview linted the SEEDED content rather
    // than the pre-mount empty state. h1 -> h2 is a valid increment, so there is
    // NO heading-increment yet. The anchor sits on line 0, untouched by the
    // line-2 edit below, so it persists across the edit.
    await fs.writeFile(tempFile, "# Title \n\n## Sub\n");
    const uri = vscode.Uri.file(tempFile);

    const hasCode = (ds: readonly vscode.Diagnostic[], code: string): boolean =>
      ds.some((d) => isQuollLint(d) && d.code === code);

    await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);

    // Baseline (non-vacuous): wait for the trailing-space finding — this proves
    // the webview mounted and linted the seeded document. heading-increment and
    // no-trailing-spaces run in the SAME lint pass, so once the anchor is
    // observed, the absence of heading-increment is a real negative, not a race
    // against an unmounted webview.
    const baseline = await waitForDiagnostics(uri, (ds) => hasCode(ds, "no-trailing-spaces"), 6000);
    assert.ok(
      !hasCode(baseline, "heading-increment"),
      "clean headings must not flag heading-increment before the edit"
    );

    // Introduce a skip via an external edit ("## Sub" -> "### Sub": h1 -> h3).
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, doc.lineAt(2).range, "### Sub");
    assert.strictEqual(await vscode.workspace.applyEdit(edit), true);

    // The new finding surfaces at the edited heading line; the trailing-space
    // anchor still persists (the edit did not touch line 0).
    const after = await waitForDiagnostics(uri, (ds) => hasCode(ds, "heading-increment"));
    const hi = after.find((d) => isQuollLint(d) && d.code === "heading-increment");
    assert.ok(hi, "expected heading-increment after the external edit");
    assert.strictEqual(hi.range.start.line, 2, "diagnostic must land on the edited heading line");
    assert.ok(hasCode(after, "no-trailing-spaces"), "the trailing-space anchor must persist");
  });
});
