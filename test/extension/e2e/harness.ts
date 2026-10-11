import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { makeTempDir } from "../temp-root";
import type {
  DocumentMessageShape,
  EditorConfigMessageShape,
  FormatCommandMessageShape,
  PanelControlsShape,
  RecordedEventShape,
  TestHarnessShape,
  ThemeMessageShape,
} from "./types";

export const EXTENSION_ID = "mtskf.quoll";
export const VIEW_TYPE = "quoll.editMarkdown";

// Every temp dir an E2E suite creates lives under the run root that
// launch.ts made and disposes on exit — that single owner is why no suite
// needs dir teardown of its own, and why nothing here ever globs
// `quoll-e2e-*` (a parallel run owns its own root). Suites must NOT call
// fs.mkdtemp(os.tmpdir(), …); test/extension/temp-dir-choke-point.test.ts
// enforces that. Re-exported so suites keep importing from "./harness".
export { makeTempDir, makeTempDirSync } from "../temp-root";

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
  suppressRescuedDrafts(api.__test.harness);
  return api.__test.harness;
}

// Closing a Quoll tab with a write-gate rejection pending reopens the rejected
// draft as a DIRTY untitled document. Left on, that side effect would leak into
// every suite: the untitled tab steals the active editor from the next test, a
// plain close of it raises a save prompt the headless host cannot answer, and
// `cleanupBetweenTests`' own close can start one after a test failed half-way —
// so no per-test "wait, then discard" could cover it. Routing the open through
// a no-op keeps the rescue out of every suite that is not about it. Installed
// by every `getHarness()` call, so a suite that wants the real path (or a
// recorder) must set `openRescuedDraftOverride` AFTER its last `getHarness()`.
export function suppressRescuedDrafts(harness: TestHarnessShape): void {
  harness.openRescuedDraftOverride = () => Promise.resolve();
}

export const untitledTextTabs = (): vscode.Tab[] =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputText && t.input.uri.scheme === "untitled");

/** Discard every untitled text tab without a save prompt (focus it, then the
 *  "Don't Save" close). A plain close of a dirty untitled document blocks on a
 *  modal the headless host cannot answer, so this runs BEFORE any close-all. */
export async function discardUntitledTabs(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const tab = untitledTextTabs()[0];
    if (!tab) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument((tab.input as vscode.TabInputText).uri);
    await vscode.window.showTextDocument(doc, {
      viewColumn: tab.group.viewColumn,
      preserveFocus: false,
    });
    await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
    await tick(50);
  }
  if (untitledTextTabs().length > 0) {
    throw new Error("discardUntitledTabs: untitled tabs still open after 10 attempts");
  }
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
//
// Rejected-draft rescue: suppression is (re)installed FIRST so the close below
// can never start a real rescue — even when the failing test left the override
// at `null` — and again after `reset()`, which clears every override. Untitled
// tabs are discarded before the close-all as a backstop, so a real rescued
// draft never meets a plain close (see `suppressRescuedDrafts`).
export async function cleanupBetweenTests(harness: TestHarnessShape): Promise<void> {
  suppressRescuedDrafts(harness);
  await discardUntitledTabs();
  await closeAllEditors();
  await tick(50);
  harness.reset();
  suppressRescuedDrafts(harness);
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
// to message.themeKind.
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

// Type-guard for outbound format-command messages. Mirrors isEditorConfigEvent
// so a dispatch test's narrowing flows through to message.action — without it
// `.action` resolves through RecordedEventShape's `Record<string, unknown>` and
// a renamed field (or a typo at the assertion) only fails at runtime.
export function isFormatCommandEvent(
  e: RecordedEventShape
): e is RecordedEventShape & { message: FormatCommandMessageShape } {
  return e.message.type === "format-command";
}

// Poll `predicate` until true, or throw naming what was awaited. Lives here so
// new suites stop adding a private copy of the same loop. NOTE the older suites
// have NOT been folded in yet: format-document-active-edge and
// status-bar-active-edge still carry byte-identical local copies, so a change to
// the wait semantics here does not reach them (that dedupe is its own change).
export async function pollUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 8000
): Promise<void> {
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

/** Open a temp `.md` in Quoll and return the NEWLY-registered panel controls.
 *  `previous` guards the second open of a two-panel run: poll until activePanel
 *  becomes distinct from it, so the caller never captures the older panel.
 *  Deliberately NOT defaulted — a caller who forgets it on a second open would
 *  silently get the first panel back, so the compiler asks every time (the
 *  sibling suites' private copies require it for the same reason). Pass `null`
 *  explicitly for the first open. */
export async function openTempQuoll(
  harness: TestHarnessShape,
  content: string,
  slug: string,
  previous: PanelControlsShape | null
): Promise<{ uri: vscode.Uri; file: string; panel: PanelControlsShape }> {
  const dir = await makeTempDir(slug);
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
