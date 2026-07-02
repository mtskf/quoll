import * as path from "node:path";
import * as vscode from "vscode";
import type {
  DocumentMessageShape,
  EditorConfigMessageShape,
  RecordedEventShape,
  TestHarnessShape,
  ThemeMessageShape,
} from "./types";

export const EXTENSION_ID = "mtskf.quoll";
export const VIEW_TYPE = "quoll.editMarkdown";

// __dirname at runtime is `out/test-e2e/e2e/`. Resolve up to the
// repo root then back into the source-controlled fixtures directory.
// Avoids needing to copy *.md into out/ as a build step.
//
// Fixture-directory existence is asserted ONCE at suite launch (see
// test/extension/launch.ts) rather than as a module-load side effect
// here — the latter ran on every test file's first `require()` of
// this module and surfaced a path-drift failure as a noisy per-file
// uncaught throw inside the Electron host (where the mocha context
// is gone and the runner crashes opaquely). Preflight in launch.ts
// fails the parent Node process before spawning Electron.
export const FIXTURES_DIR = path.resolve(__dirname, "../../..", "test/extension/e2e/fixtures");

export async function getHarness(): Promise<TestHarnessShape> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) {
    throw new Error(`Extension ${EXTENSION_ID} not found — check package.json publisher.name`);
  }
  // NOTE: do NOT name this `exports` — under CJS emit it shadows the
  // module's implicit `exports` binding and the runtime throws
  // "Cannot access 'exports' before initialization" via the TDZ.
  const api = (await ext.activate()) as { __test?: { harness: TestHarnessShape } } | undefined;
  if (!api?.__test?.harness) {
    throw new Error(
      "Extension activated but did not return a __test harness — is ExtensionMode.Test active?"
    );
  }
  return api.__test.harness;
}

export function fixtureUri(filename: string): vscode.Uri {
  return vscode.Uri.file(path.join(FIXTURES_DIR, filename));
}

export async function openFixtureWithQuoll(filename: string): Promise<vscode.Uri> {
  const uri = fixtureUri(filename);
  await vscode.commands.executeCommand("vscode.openWith", uri, VIEW_TYPE);
  return uri;
}

export function isDocumentEvent(
  e: RecordedEventShape
): e is RecordedEventShape & { message: DocumentMessageShape } {
  return e.message.type === "document";
}

// Factory: a Document event whose docVersion exceeds `baseVersion`.
// Returned as a typed type-guard so `waitForEvent`'s narrowing flows
// through to the awaited result without callers re-casting `message`.
export const isDocumentAfter =
  (baseVersion: number) =>
  (e: RecordedEventShape): e is RecordedEventShape & { message: DocumentMessageShape } =>
    isDocumentEvent(e) && e.message.docVersion > baseVersion;

export async function closeAllEditors(): Promise<void> {
  // Discard unsaved edits first. revertAllFiles is best-effort —
  // it's unavailable in some VS Code builds and silently no-ops
  // when there's nothing dirty.
  try {
    await vscode.commands.executeCommand("workbench.action.revertAllFiles");
  } catch (err) {
    // Best-effort, but log so a structural failure (perms denied, FS
    // detached) shows up in test output rather than as a phantom
    // dirty-workspace race the next test inherits.
    console.warn("[e2e] revertAllFiles failed (best-effort):", err);
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

export function tick(ms = 50): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Per-test cleanup: closes editors, lets the dispose chain drain, then
// resets the harness. Reset MUST come last so any events fired by the
// async dispose path (postDocument-after-close races, late
// onDidChangeViewState callbacks before disposed=true takes effect on
// the recorded post) are drained, not carried into the next test.
//
// Without the trailing tick + reset ordering, stale Document events
// from a prior test's panel leak into the next test's `waitForEvent`
// queue — see [DBG-TEST] showing seed.docVersion=3 from a leftover
// temp-file panel polluting failed-applyedit-surfaced.
export async function cleanupBetweenTests(harness: TestHarnessShape): Promise<void> {
  await closeAllEditors();
  await tick(50);
  harness.reset();
}

/** Hide the Quoll editor by opening (and focusing) another document
 *  in the same column. Returns once the focus transition has
 *  resolved. Mirrors the pattern used by hidden-webview-resync.test.ts;
 *  necessary because `panel.webviewPanel.reveal()` on an already-active
 *  panel is a no-op and does NOT fire `onDidChangeViewState`. */
export async function hideQuollByOpeningOtherDoc(): Promise<void> {
  const tmpUri = vscode.Uri.parse("untitled:Untitled-hide-pad");
  const doc = await vscode.workspace.openTextDocument(tmpUri);
  await vscode.window.showTextDocument(doc, { preserveFocus: false });
}

// Type-guard for outbound theme messages. Mirrors isDocumentEvent so a
// theme-propagation test can waitForEvent with narrowing flowing through
// to message.isDarkTheme.
export function isThemeEvent(
  e: RecordedEventShape
): e is RecordedEventShape & { message: ThemeMessageShape } {
  return e.message.type === "theme";
}

// Type-guard for outbound editor-config messages. Mirrors isThemeEvent so a
// delivery test can waitForEvent with narrowing flowing through to
// message.lintGutter.
export function isEditorConfigEvent(
  e: RecordedEventShape
): e is RecordedEventShape & { message: EditorConfigMessageShape } {
  return e.message.type === "editor-config";
}

// Externally-settled promise. An applyEditOverride that returns
// `deferred().promise` holds the host write lock (pendingApplyBaseVersion
// stays non-null) until the test resolves it — the only way to observe the
// lock-held guard arms (ready drop, visible-edge drop) at the integration
// boundary.
export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
