// Test-only observation seam. Instantiated only when
// ExtensionMode.Test is active (see src/extension/extension.ts). All
// hook sites in QuollEditorPanel short-circuit on `harness ===
// undefined` so production code paths are unchanged.
//
// Two event streams:
//   - `events`        : host→webview (recorded inside `post()`).
//   - `inboundEvents` : webview→host RECEIVED via the real
//                       `webview.onDidReceiveMessage` callback, plus
//                       `rawSimulate` (which mirrors that callback:
//                       record THEN handle). `simulateInbound` calls do
//                       NOT push here — they bypass the recorder to
//                       drive a typed message straight into
//                       `handleInbound`.
// This split lets editor-resolves prove the real webview bundle ran
// (real `ready` arrived) while other tests drive inbound traffic
// programmatically without the real webview bundle's cooperation. `rawSimulate`
// closes the remaining gap: it routes an `unknown` payload through the
// SAME pre-validator recorder as the real surface, so a test can pin
// the `isWebviewToHost` reject branch on a wire-malformed message.
//
// `setActivePanel(null, expected)` uses identity comparison against
// the previously installed `PanelControls` so a late-dispose race
// (panel A disposes after panel B has registered) does NOT null
// out the currently active panel. Callers MUST pass `expected` to
// opt into identity-on-clear; a bare `setActivePanel(null)` throws
// (use `reset()` for unconditional clear — see the throw site on
// the method itself for the contract rationale). The contract: by
// the time `harness.waitForEvent(isDocumentEvent)` resolves for an
// opened fixture, `harness.activePanel` is the matching PanelControls.

import type { TextDocument, Uri, WebviewPanel, WorkspaceEdit } from "vscode";

import type { HostToWebview, WebviewToHost } from "../shared/protocol.js";

export interface RecordedEvent {
  readonly message: HostToWebview;
  readonly timestamp: number;
}

export interface RecordedInbound {
  /** Raw unknown — recorded before validator runs, so tests can
   *  observe shapes the host would have rejected (e.g. malformed
   *  payloads in future fuzz tests). */
  readonly raw: unknown;
  readonly timestamp: number;
}

export interface PanelControls {
  readonly document: TextDocument;
  readonly webviewPanel: WebviewPanel;
  simulateInbound(message: WebviewToHost): void;
  /** Wire-level inbound simulation. Unlike `simulateInbound` — which
   *  takes a well-typed `WebviewToHost` and routes it straight into
   *  `handleInbound`, bypassing the inbound recorder — `rawSimulate`
   *  takes `unknown` and mirrors the real `webview.onDidReceiveMessage`
   *  callback exactly: it pushes the raw payload to `_inboundEvents`
   *  via `recordInbound` AND THEN runs `handleInbound`. This lets a
   *  test drive a wire-malformed payload (e.g. a protocol-version
   *  mismatch) through the `isWebviewToHost` validator and observe both
   *  that the recorder fired (received) and that the validator dropped
   *  it (no Document reply). */
  rawSimulate(raw: unknown): void;
}

type EventWaiter = {
  predicate: (e: RecordedEvent) => boolean;
  resolve: (e: RecordedEvent) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type InboundWaiter = {
  predicate: (e: RecordedInbound) => boolean;
  resolve: (e: RecordedInbound) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type ErrorWaiter = {
  predicate: (msg: string) => boolean;
  resolve: (msg: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/** Test-installed override hooks. Every test override lives in one
 *  registry so a single `reset()` clears them wholesale (`this._overrides
 *  = createOverrides()`) instead of one nullable field per hook, each
 *  needing its own teardown line. The footgun that motivated this: a
 *  newly-added override whose matching `reset()` line was forgotten would
 *  silently survive into a later test. Routing through one registry
 *  removes that hazard structurally — the `TestOverrides` shape forces
 *  `createOverrides()` to account for every key (a new field is a tsc
 *  error until it is nulled there), so no override can escape the clear
 *  path. TestHarness exposes each slot through a public getter/setter
 *  pair so call sites (`harness.xOverride = fn`) stay unchanged. */
interface TestOverrides {
  /** When non-null, the panel routes its accept-arm WorkspaceEdit
   *  through this instead of `workspace.applyEdit`. A rejected Promise
   *  (or a sync throw) flows into the panel's existing `.then(_, err)`
   *  arm — same recovery path as a real applyEdit rejection. */
  applyEdit: ((edit: WorkspaceEdit) => Thenable<boolean>) | null;
  /** When non-null, the panel routes its outbound `post()` helper's
   *  actual `webview.postMessage` call through this instead of the real
   *  webview surface. Returning `false` (= runtime rejected / not
   *  currently routable) or a rejecting Thenable (= transport detached)
   *  exercises the host's non-acceptance arms — used by
   *  post-records-accepted-only.test to pin that `recordEvent` only
   *  fires on `ok === true`. */
  webviewPostMessage: ((message: HostToWebview) => Thenable<boolean>) | null;
  /** When non-null, the panel's `case "open-external"` arm routes
   *  `handleOpenExternal`'s injected `openExternal` dep through this
   *  instead of `(url) => env.openExternal(Uri.parse(url))`. The override
   *  sees the already-allowlist-gated, post-decode href as a plain string
   *  and is used by the open-external E2E test to pin the case arm's
   *  delegation contract without depending on the real `env` binding
   *  (which the test process cannot spy on through the vscode module
   *  namespace). */
  openExternal: ((url: string) => Thenable<boolean>) | null;
  /** When non-null, the panel's `case "open-link"` arm routes
   *  `handleOpenLink`'s injected `openWith` dep through this instead of
   *  `(uri) => openInQuollEditor(uri, QuollEditorPanel.viewType)`. The
   *  override sees the host-resolved, containment-gated target Uri and is
   *  used by the open-link E2E test to assert the resolved target
   *  deterministically (and to confirm the containment gate drops
   *  out-of-scope targets) without depending on the real `vscode.openWith`
   *  command. */
  openLink: ((uri: Uri) => Thenable<unknown>) | null;
  /** When non-null, resolveCustomTextEditor builds the webview HTML
   *  through this instead of `QuollEditorPanel.getWebviewContent`. The
   *  override may throw synchronously to simulate a `buildWebviewHtml`
   *  validator failure (bad cspSource / nonce / scriptUri / stylesUri),
   *  letting webview-html-build-failure.test pin the panel-side catch →
   *  showError → early-return arm without an injectable invalid input at
   *  the integration boundary. */
  buildWebviewHtml: (() => string) | null;
  /** When non-null, the Panel's writeImage impl routes `workspace.fs.writeFile`
   *  through this instead of the real FS, so the image-write E2E can assert
   *  whether a write was attempted without touching disk. */
  writeImageFile: ((uri: Uri, content: Uint8Array) => Thenable<void>) | null;
  /** When non-null, the panel routes its dirty-doc on-disk conflict prompt
   *  through this instead of `window.showWarningMessage`. Lets the e2e observe
   *  that the prompt fired (a divergence was detected) AND inject the user's
   *  choice ("Reload from disk" / "Keep my edits" / undefined = dismissed)
   *  without a real modal the headless host cannot click. */
  diskConflictPrompt:
    | ((message: string, ...actions: string[]) => Thenable<string | undefined>)
    | null;
}

/** Fresh all-null override registry — the single source of truth for
 *  which overrides exist and their cleared value. `reset()` reassigns
 *  `_overrides` from this, so teardown can never miss a hook. */
function createOverrides(): TestOverrides {
  return {
    applyEdit: null,
    webviewPostMessage: null,
    openExternal: null,
    openLink: null,
    buildWebviewHtml: null,
    writeImageFile: null,
    diskConflictPrompt: null,
  };
}

export class TestHarness {
  private readonly _events: RecordedEvent[] = [];
  private readonly _inboundEvents: RecordedInbound[] = [];
  private readonly _eventWaiters: EventWaiter[] = [];
  private readonly _inboundWaiters: InboundWaiter[] = [];
  private readonly _errorWaiters: ErrorWaiter[] = [];
  private _activePanel: PanelControls | null = null;

  /** Test-installed override hooks — see `TestOverrides`. Held in one
   *  registry so `reset()` clears every override through a single path
   *  (`this._overrides = createOverrides()`); the public getter/setter
   *  pairs below keep the `harness.xOverride` call sites unchanged. */
  private _overrides: TestOverrides = createOverrides();

  /** Last argument passed to the panel's `showError` helper.
   *  Host-owned: written only by `recordError` and cleared by
   *  `reset()`. Exposed to tests read-only through the `lastError`
   *  getter (no setter): were a test able to null it after
   *  `recordError` has fired but before `waitForError` runs, the
   *  `waitForError` fast-path (`_lastError !== null`) would miss the
   *  already-recorded error and instead register a fresh waiter that
   *  then times out. */
  private _lastError: string | null = null;

  get events(): readonly RecordedEvent[] {
    return this._events;
  }

  get inboundEvents(): readonly RecordedInbound[] {
    return this._inboundEvents;
  }

  get activePanel(): PanelControls | null {
    return this._activePanel;
  }

  /** Read by the panel's accept arm to decide whether to route the
   *  WorkspaceEdit through a test override instead of `workspace.applyEdit`. */
  get applyEditOverride(): ((edit: WorkspaceEdit) => Thenable<boolean>) | null {
    return this._overrides.applyEdit;
  }

  set applyEditOverride(override: ((edit: WorkspaceEdit) => Thenable<boolean>) | null) {
    this._overrides.applyEdit = override;
  }

  /** Read by the panel's `post()` helper to route `webview.postMessage`
   *  through a test override — see `TestOverrides.webviewPostMessage`. */
  get webviewPostMessageOverride(): ((message: HostToWebview) => Thenable<boolean>) | null {
    return this._overrides.webviewPostMessage;
  }

  set webviewPostMessageOverride(override: ((message: HostToWebview) => Thenable<boolean>) | null) {
    this._overrides.webviewPostMessage = override;
  }

  /** Read by the panel's `case "open-external"` arm to route the
   *  `openExternal` dep through a test override — see
   *  `TestOverrides.openExternal`. */
  get openExternalOverride(): ((url: string) => Thenable<boolean>) | null {
    return this._overrides.openExternal;
  }

  set openExternalOverride(override: ((url: string) => Thenable<boolean>) | null) {
    this._overrides.openExternal = override;
  }

  /** Read by the panel's `case "open-link"` arm to route the
   *  `openWith` dep through a test override — see `TestOverrides.openLink`. */
  get openLinkOverride(): ((uri: Uri) => Thenable<unknown>) | null {
    return this._overrides.openLink;
  }

  set openLinkOverride(override: ((uri: Uri) => Thenable<unknown>) | null) {
    this._overrides.openLink = override;
  }

  /** Read by resolveCustomTextEditor to build the webview HTML through a
   *  test override — see `TestOverrides.buildWebviewHtml`. */
  get buildWebviewHtmlOverride(): (() => string) | null {
    return this._overrides.buildWebviewHtml;
  }

  set buildWebviewHtmlOverride(override: (() => string) | null) {
    this._overrides.buildWebviewHtml = override;
  }

  get writeImageFileOverride(): ((uri: Uri, content: Uint8Array) => Thenable<void>) | null {
    return this._overrides.writeImageFile;
  }

  set writeImageFileOverride(override: ((uri: Uri, content: Uint8Array) => Thenable<void>) | null) {
    this._overrides.writeImageFile = override;
  }

  /** Read by the panel's dirty-doc conflict watcher to route the warning
   *  prompt through a test override — see `TestOverrides.diskConflictPrompt`. */
  get diskConflictPromptOverride():
    | ((message: string, ...actions: string[]) => Thenable<string | undefined>)
    | null {
    return this._overrides.diskConflictPrompt;
  }

  set diskConflictPromptOverride(override:
    | ((message: string, ...actions: string[]) => Thenable<string | undefined>)
    | null) {
    this._overrides.diskConflictPrompt = override;
  }

  /** Read-only view of the last `showError` argument — see `_lastError`
   *  for why this has no setter. */
  get lastError(): string | null {
    return this._lastError;
  }

  recordEvent(message: HostToWebview): void {
    const entry: RecordedEvent = { message, timestamp: Date.now() };
    this._events.push(entry);
    for (let i = this._eventWaiters.length - 1; i >= 0; i--) {
      const w = this._eventWaiters[i];
      if (w.predicate(entry)) {
        clearTimeout(w.timer);
        w.resolve(entry);
        this._eventWaiters.splice(i, 1);
      }
    }
  }

  recordInbound(raw: unknown): void {
    const entry: RecordedInbound = { raw, timestamp: Date.now() };
    this._inboundEvents.push(entry);
    for (let i = this._inboundWaiters.length - 1; i >= 0; i--) {
      const w = this._inboundWaiters[i];
      if (w.predicate(entry)) {
        clearTimeout(w.timer);
        w.resolve(entry);
        this._inboundWaiters.splice(i, 1);
      }
    }
  }

  recordError(message: string): void {
    this._lastError = message;
    for (let i = this._errorWaiters.length - 1; i >= 0; i--) {
      const w = this._errorWaiters[i];
      if (w.predicate(message)) {
        clearTimeout(w.timer);
        w.resolve(message);
        this._errorWaiters.splice(i, 1);
      }
    }
  }

  /** Identity-on-clear: only nulls out the active panel if the
   *  passed `expected` reference matches the currently stored one.
   *  Set semantics are unconditional.
   *
   *  A bare `setActivePanel(null)` (no `expected`) throws — an
   *  unconditional clear racing a late-dispose would clobber a
   *  newer panel that has already registered after panel A's
   *  dispose was scheduled but before its callback fired. Callers
   *  that genuinely want an unconditional drop should call
   *  `reset()` instead (which clears the panel along with every
   *  other piece of per-test state). The only legitimate clear
   *  path is `setActivePanel(null, panelControls)` from a panel's
   *  own `onDidDispose`, which is identity-checked. */
  setActivePanel(panel: PanelControls | null, expected?: PanelControls): void {
    if (panel === null) {
      if (!expected) {
        throw new Error(
          "setActivePanel(null) requires an `expected` reference — bare clear races late-dispose. Use reset() for an unconditional drop."
        );
      }
      if (this._activePanel !== expected) {
        return;
      }
      this._activePanel = null;
      return;
    }
    this._activePanel = panel;
  }

  waitForEvent(predicate: (e: RecordedEvent) => boolean, timeoutMs = 5000): Promise<RecordedEvent> {
    const existing = this._events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._eventWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) {
          this._eventWaiters.splice(idx, 1);
        }
        reject(new Error(`waitForEvent timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._eventWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  waitForInbound(
    predicate: (e: RecordedInbound) => boolean,
    timeoutMs = 8000
  ): Promise<RecordedInbound> {
    const existing = this._inboundEvents.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._inboundWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) {
          this._inboundWaiters.splice(idx, 1);
        }
        reject(new Error(`waitForInbound timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._inboundWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  waitForError(predicate: (msg: string) => boolean, timeoutMs = 5000): Promise<string> {
    if (this._lastError !== null && predicate(this._lastError)) {
      return Promise.resolve(this._lastError);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._errorWaiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) {
          this._errorWaiters.splice(idx, 1);
        }
        reject(new Error(`waitForError timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this._errorWaiters.push({ predicate, resolve, reject, timer });
    });
  }

  /** Single per-test reset. Drains both streams, rejects pending
   *  waiters with a clear message (so a stale waiter does not
   *  silently survive into the next test), clears every override
   *  hook wholesale (`_overrides = createOverrides()` — no per-hook
   *  nulling a new override could miss) and lastError. Also nulls
   *  `_activePanel` so a new
   *  test does not observe the prior test's panel before its own
   *  `resolveCustomTextEditor` runs — identity-on-clear protects
   *  the late-dispose direction but does not protect a new test
   *  from reading a stale panel before its own resolve fires.
   *
   *  NOTE on unhandled rejections: a pending `waitForXxx(...)` whose
   *  return value is not awaited (e.g. `void harness.waitForEvent(...)`)
   *  will surface the "TestHarness.reset() called" rejection as a
   *  Mocha unhandled-rejection failure. Tests MUST `await` every
   *  `waitForXxx` they start or wrap it in `.catch(() => undefined)`. */
  reset(): void {
    this._events.length = 0;
    this._inboundEvents.length = 0;
    const drainErr = new Error("TestHarness.reset() called");
    for (const w of this._eventWaiters) {
      clearTimeout(w.timer);
      w.reject(drainErr);
    }
    this._eventWaiters.length = 0;
    for (const w of this._inboundWaiters) {
      clearTimeout(w.timer);
      w.reject(drainErr);
    }
    this._inboundWaiters.length = 0;
    for (const w of this._errorWaiters) {
      clearTimeout(w.timer);
      w.reject(drainErr);
    }
    this._errorWaiters.length = 0;
    this._overrides = createOverrides();
    this._lastError = null;
    // Symmetric to identity-on-clear: new tests must not observe the
    // prior test's panel. The panel's own onDidDispose will also call
    // setActivePanel(null, panelControls); that call no-ops here
    // because we already null'd _activePanel.
    this._activePanel = null;
  }

  /** Subset of reset() — only clears the outbound `_events` stream
   *  and its `_eventWaiters`. Inbound events, inbound waiters, error
   *  waiters, every override hook (`_overrides`), and `lastError` are
   *  all left intact. Use when a test wants to ignore prior outbound
   *  events but keep the override hooks or lastError state (e.g.
   *  assertion drain in hidden-webview-resync).
   *
   *  NOTE: does NOT drain `_inboundEvents`, `_inboundWaiters`, or
   *  `_errorWaiters`. If a test has an outstanding `waitForInbound`
   *  or `waitForError` and calls `clearEvents()` instead of
   *  `reset()`, those waiters stay pending until either resolved,
   *  timed out, or drained by the next `reset()`. Call `reset()`
   *  (not `clearEvents()`) in `afterEach` to guarantee full
   *  cross-test isolation. */
  clearEvents(): void {
    this._events.length = 0;
    const drainErr = new Error("TestHarness.clearEvents() called");
    for (const w of this._eventWaiters) {
      clearTimeout(w.timer);
      w.reject(drainErr);
    }
    this._eventWaiters.length = 0;
  }
}
